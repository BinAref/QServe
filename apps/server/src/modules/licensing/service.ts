/**
 * Licence activation client (spec §31, §38, §40).
 *
 * This is the *only* module in the restaurant server that makes an outbound
 * network call, and it makes one on exactly five occasions, every one of them
 * started by a person pressing a button: first activation, deactivation before
 * a move, a manual status check, a re-activation after a restore, and fetching
 * the vendor's contact details and prices. Normal service never touches it —
 * no heartbeat, no phone-home, no check at boot (spec §1).
 */

import { AppError, ErrorCode, LicenseErrorCode, normaliseLicenseKey, RestaurantMode,
         APP_VERSION, Capability, EventName, validationError,
         EMPTY_VENDOR_INFO, vendorContactUrl,
         type ActivationRequest, type ActivationResponse, type DeactivationResponse,
         type DeviceFingerprint, type RestaurantId, type VendorInfo } from '@qserve/shared';
import { monotonicCode } from '@qserve/shared';
import type { EventBus } from '../../core/event-bus.js';
import type { AuditRepository } from '../../core/repositories/audit.js';
import type { LicenseRepository } from '../../core/repositories/license.js';
import type { SettingsRepository } from '../../core/repositories/settings.js';
import type { LicenseGate } from '../../core/license-gate.js';
import type { Actor } from '@qserve/shared';

/** Activation must not hang a management console; the vendor is one call away. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface LicenseClientOptions {
  readonly licenseServerUrl: string;
  readonly deviceFingerprint: DeviceFingerprint;
  readonly deviceLabel: string;
}

export class LicensingService {
  constructor(
    private readonly options: LicenseClientOptions,
    private readonly repository: LicenseRepository,
    private readonly settings: SettingsRepository,
    private readonly gate: LicenseGate,
    private readonly audit: AuditRepository,
    private readonly bus: EventBus,
  ) {}

  /* ----------------------------------------------------------- transport */

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.options.licenseServerUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // A network failure here is expected and survivable: the restaurant keeps
      // trading on its existing certificate. Say so precisely.
      throw new AppError(
        LicenseErrorCode.SERVER_UNREACHABLE,
        `could not reach the licence server at ${this.options.licenseServerUrl}`,
        {
          status: 503,
          messageKey: 'license.error.server_unreachable',
          details: { url: this.options.licenseServerUrl },
          cause: error,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const error = payload['error'] as
        | { code?: string; messageKey?: string; details?: Record<string, unknown> }
        | undefined;
      throw new AppError(error?.code ?? ErrorCode.INTERNAL, 'licence request refused', {
        status: response.status,
        messageKey: error?.messageKey ?? 'license.error.refused',
        details: error?.details ?? {},
      });
    }
    return payload as T;
  }

  private async getJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.options.licenseServerUrl}${path}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      throw new AppError(
        LicenseErrorCode.SERVER_UNREACHABLE,
        `could not reach the licence server at ${this.options.licenseServerUrl}`,
        {
          status: 503,
          messageKey: 'license.error.server_unreachable',
          details: { url: this.options.licenseServerUrl },
          cause: error,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /* --------------------------------------------------------- vendor info */

  /**
   * Who to contact for a licence, and what the vendor charges for one and for
   * moving one. The application takes no payment: it shows the vendor's own
   * words and a link to talk to them.
   *
   * Cached in settings, because a restaurant deciding to buy is often the same
   * restaurant whose internet is not working — which is why it bought an
   * offline system in the first place.
   */
  async refreshVendorInfo(): Promise<{ info: VendorInfo; fetchedAt: string }> {
    const info = await this.getJson<VendorInfo>('/api/v1/vendor-info');
    const cached = { info, fetchedAt: new Date().toISOString() };
    this.settings.set('license.vendorInfoCache', cached);
    return cached;
  }

  /** The cached copy, plus how to reach the vendor about *this* restaurant. */
  vendorInfo(): {
    info: VendorInfo;
    fetchedAt: string | null;
    stale: boolean;
    contacts: { kind: string; label: string; value: string; url: string | null }[];
    request: ReturnType<LicensingService['licenceRequest']>;
  } {
    const cached = this.settings.get<{ info: VendorInfo; fetchedAt: string } | null>(
      'license.vendorInfoCache',
    );
    const info = cached?.info ?? EMPTY_VENDOR_INFO;

    return {
      info,
      fetchedAt: cached?.fetchedAt ?? null,
      // A month-old price list is worth re-checking before quoting it to anyone.
      stale: cached
        ? Date.now() - Date.parse(cached.fetchedAt) > 30 * 24 * 60 * 60 * 1000
        : true,
      contacts: info.contacts.map((contact) => ({
        kind: contact.kind,
        label: contact.label,
        value: contact.value,
        // No prefilled text here: the console appends its own, translated.
        url: vendorContactUrl(contact),
      })),
      request: this.licenceRequest(),
    };
  }

  /* ---------------------------------------------------------- activation */

  /**
   * Activate this device. On success the certificate is stored, the licence
   * gate re-evaluates offline, and — crucially — the restaurant keeps every
   * category, product and setting it built during SETUP (spec §2).
   */
  async activate(input: {
    licenseKey: string;
    rememberKey: boolean;
    actor: Actor;
    clientIp: string | null;
  }): Promise<{ mode: RestaurantMode; restaurantId: string; licenseId: string }> {
    const normalised = normaliseLicenseKey(input.licenseKey);
    if (!normalised) {
      throw new AppError(LicenseErrorCode.INVALID_KEY_FORMAT, 'that licence key is not valid', {
        status: 400,
        messageKey: 'license.error.invalid_key_format',
      });
    }

    const profile = this.settings.profile();
    if (!profile) {
      throw validationError('create the restaurant before activating a licence');
    }

    const nonce = monotonicCode(12);
    const request: ActivationRequest = {
      licenseKey: normalised,
      deviceFingerprint: this.options.deviceFingerprint,
      deviceLabel: this.options.deviceLabel,
      appVersion: APP_VERSION,
      nonce,
      // Send our own id only once we have a vendor-issued one. A SETUP
      // installation holds a provisional id and must adopt the licence's.
      ...(profile.restaurantId.startsWith('REST-')
        ? { restaurantId: profile.restaurantId as RestaurantId }
        : {}),
      restaurantName: Object.values(profile.name)[0] ?? 'Restaurant',
    };

    const response = await this.post<ActivationResponse>('/api/v1/activate', request);

    if (response.nonce !== nonce) {
      // A mismatched nonce means the reply is not an answer to this request.
      throw new AppError(LicenseErrorCode.SIGNATURE_INVALID, 'unexpected activation response', {
        status: 502,
        messageKey: 'license.error.bad_response',
      });
    }

    // Adopt the vendor's Restaurant ID, keeping all local data attached to it.
    if (profile.restaurantId !== response.restaurantId) {
      this.settings.adoptRestaurantId(response.restaurantId);
    }

    const snapshot = this.gate.installCertificate(
      response.certificate,
      response.restaurantId as RestaurantId,
    );

    if (snapshot.mode !== RestaurantMode.OPERATIONAL) {
      throw new AppError(
        LicenseErrorCode.SIGNATURE_INVALID,
        `the licence server issued a certificate this installation cannot verify (${snapshot.verdict})`,
        { status: 502, messageKey: 'license.error.certificate_rejected',
          details: { verdict: snapshot.verdict } },
      );
    }

    if (input.rememberKey) this.repository.rememberKey(normalised);
    else this.repository.setKeyHint(normalised.slice(-5));

    this.audit.record({
      action: 'license.activated',
      actor: input.actor,
      entityType: 'license',
      entityId: response.licenseId,
      after: { restaurantId: response.restaurantId, licenseId: response.licenseId },
      detail: { transferCount: snapshot.payload?.transferCount ?? 0 },
      clientIp: input.clientIp,
    });

    this.bus.publish({
      name: EventName.SYSTEM_MODE_CHANGED,
      payload: { mode: snapshot.mode, capabilities: snapshot.capabilities },
    });

    return {
      mode: snapshot.mode,
      restaurantId: response.restaurantId,
      licenseId: response.licenseId,
    };
  }

  /**
   * Release this device so the licence can move (spec §6). The local menu and
   * order history stay exactly where they are — deactivation is about the
   * binding, not the data.
   */
  async deactivate(input: {
    licenseKey?: string;
    reason: string;
    actor: Actor;
    clientIp: string | null;
  }): Promise<{ mode: RestaurantMode }> {
    const key = normaliseLicenseKey(input.licenseKey ?? this.repository.rememberedKey() ?? '');
    if (!key) {
      throw new AppError(
        LicenseErrorCode.INVALID_KEY_FORMAT,
        'the licence key is needed to deactivate this device',
        { status: 400, messageKey: 'license.error.key_required' },
      );
    }

    await this.post<DeactivationResponse>('/api/v1/deactivate', {
      licenseKey: key,
      deviceFingerprint: this.options.deviceFingerprint,
      reason: input.reason,
      nonce: monotonicCode(12),
    });

    const snapshot = this.gate.clearCertificate();
    this.repository.clear();

    this.audit.record({
      action: 'license.deactivated',
      actor: input.actor,
      entityType: 'license',
      detail: { reason: input.reason },
      clientIp: input.clientIp,
    });

    this.bus.publish({
      name: EventName.SYSTEM_MODE_CHANGED,
      payload: { mode: snapshot.mode, capabilities: snapshot.capabilities },
    });

    return { mode: snapshot.mode };
  }

  /** Manual status probe. Never called automatically. */
  async remoteStatus(licenseKey?: string): Promise<Record<string, unknown>> {
    const key = normaliseLicenseKey(licenseKey ?? this.repository.rememberedKey() ?? '');
    if (!key) {
      throw new AppError(LicenseErrorCode.INVALID_KEY_FORMAT, 'no licence key available', {
        status: 400, messageKey: 'license.error.key_required',
      });
    }
    return this.post<Record<string, unknown>>('/api/v1/status', { licenseKey: key });
  }

  /* -------------------------------------------------------------- local */

  /** Everything the licence screen shows, computed without a network call. */
  localStatus(): Record<string, unknown> {
    const snapshot = this.gate.current;
    const row = this.repository.state();
    return {
      mode: snapshot.mode,
      verdict: snapshot.verdict,
      explanation: this.gate.explain(),
      capabilities: snapshot.capabilities,
      lockedCapabilities: Object.values(Capability).filter(
        (capability) => !snapshot.capabilities.includes(capability),
      ),
      licenseId: snapshot.payload?.licenseId ?? row.license_id,
      licenseType: snapshot.payload?.licenseType ?? row.license_type,
      activatedAt: snapshot.payload?.issuedAt ?? row.activated_at,
      transferCount: snapshot.payload?.transferCount ?? row.transfer_count,
      keyHint: row.key_hint,
      keyRemembered: this.repository.rememberedKey() !== null,
      deviceFingerprint: this.options.deviceFingerprint,
      deviceLabel: this.options.deviceLabel,
      appVersion: APP_VERSION,
      licenseServerUrl: this.options.licenseServerUrl,
    };
  }

  /**
   * Pre-filled WhatsApp message for the "Request licence" button (spec §31).
   * Carries only what the vendor needs to issue a key: no menu, no orders, no
   * customer data, no device secrets.
   */
  /**
   * The facts a vendor needs to identify this installation. Deliberately data,
   * not prose: the console renders the actual message from translation keys, so
   * a licence request goes out in the owner's own language rather than in text
   * compiled into the server (spec §32).
   */
  licenceRequest(): {
    restaurantName: string;
    restaurantId: string | null;
    appVersion: string;
    deviceLabel: string;
    deviceFingerprint: string;
  } {
    const profile = this.settings.profile();
    return {
      restaurantName: profile
        ? profile.name[profile.defaultLocale] ?? Object.values(profile.name)[0] ?? ''
        : '',
      restaurantId: profile?.restaurantId ?? null,
      appVersion: APP_VERSION,
      deviceLabel: this.options.deviceLabel,
      deviceFingerprint: this.options.deviceFingerprint,
    };
  }
}
