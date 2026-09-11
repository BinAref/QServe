/**
 * License lifecycle rules (spec §5, §6, §26–§28).
 *
 * The invariants this file exists to hold:
 *
 *  1. A licence is bound to at most one live device at a time.
 *  2. The first activation is included in the purchase; every later move to a
 *     different machine is a *transfer* and needs a credit the vendor grants
 *     after the transfer fee is settled.
 *  3. Re-activating the same machine (reinstall, restore, app upgrade) is free
 *     and idempotent — it must be, or a crashed PC would cost the restaurant
 *     money to bring back.
 *  4. A revoked licence never activates again.
 *  5. Restaurant identity survives every transfer: the Restaurant ID issued at
 *     purchase is the one the certificate carries forever.
 */

import {
  ACTIVATION_CERTIFICATE_VERSION, AppError, ErrorCode, LicenseErrorCode, LicenseStatus,
  LicenseType, LICENSED_CAPABILITIES, normaliseLicenseKey, monotonicCode,
  type ActivationCertificate, type ActivationCertificatePayload, type ActivationRequest,
  type ActivationResponse, type DeactivationRequest, type DeactivationResponse,
  type DeviceFingerprint, type LicenseId, type RestaurantId,
  EMPTY_VENDOR_INFO, VendorContactKind,
  type VendorContact, type VendorInfo,
} from '@qserve/shared';
import { computeKeyId, hashToken, issueCertificate } from '@qserve/crypto';
import type { LicenseStore, LicenseRow, RestaurantRow } from './store.js';

export interface SigningMaterial {
  readonly privateKey: string;
  readonly publicKey: string;
  readonly keyId: string;
}

/*
 * The `LICENSE_` prefix is dropped on the way to a translation key.
 *
 * The codes read `LICENSE_REVOKED`; the sentences are filed under
 * `license.error.revoked`. Interpolating the code as it stands asks for
 * `license.error.license_revoked`, which does not exist — so the front end
 * fell through to the English detail string and an Arabic restaurant was told
 * "this licence has been revoked" in English. Nothing broke, which is why it
 * survived this long.
 */
const licenseError = (code: string, status: number, detail: string): AppError =>
  new AppError(code, detail, { status, messageKey: licenseMessageKey(code) });

/** `LICENSE_REVOKED` → `license.error.revoked`; `NOT_FOUND` → `error.not_found`. */
export function licenseMessageKey(code: string): string {
  return code.startsWith('LICENSE_')
    ? `license.error.${code.slice('LICENSE_'.length).toLowerCase()}`
    : `error.${code.toLowerCase()}`;
}

export interface IssueLicenseInput {
  readonly restaurantId?: string;
  readonly restaurantName?: string;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly contactEmail?: string | null;
  readonly country?: string | null;
  readonly notes?: string | null;
  readonly licenseType?: LicenseType;
  readonly actor: string;
  readonly clientIp?: string | null;
}

export interface IssuedLicense {
  readonly license: LicenseRow;
  readonly restaurant: RestaurantRow;
  /** Shown to the vendor exactly once. Never stored, never recoverable. */
  readonly licenseKey: string;
}

export class LicenseService {
  constructor(
    private readonly store: LicenseStore,
    private readonly signing: SigningMaterial | null,
    private readonly licenseYear: number,
    private readonly generateKey: () => string,
  ) {}

  private requireSigning(): SigningMaterial {
    if (!this.signing) {
      throw new AppError(
        ErrorCode.INTERNAL,
        'license server has no signing key configured; set QSERVE_LS_SIGNING_KEY_FILE',
        { status: 503, messageKey: 'license.error.server_not_configured' },
      );
    }
    return this.signing;
  }

  /* ------------------------------------------------------------- issuing */

  /**
   * Create a licence, and the restaurant record if this is a new customer.
   * The vendor never types key material: the key is generated here (spec §30).
   */
  issueLicense(input: IssueLicenseInput): IssuedLicense {
    return this.store.tx(() => {
      let restaurant: RestaurantRow;

      if (input.restaurantId) {
        const existing = this.store.getRestaurant(input.restaurantId);
        if (!existing) throw licenseError(ErrorCode.NOT_FOUND, 404, 'restaurant not found');
        restaurant = existing;
      } else {
        const name = input.restaurantName?.trim();
        if (!name) {
          throw new AppError(ErrorCode.VALIDATION, 'restaurantName or restaurantId is required', {
            messageKey: 'license.error.restaurant_required',
          });
        }
        restaurant = this.store.createRestaurant({
          name,
          contactName: input.contactName ?? null,
          contactPhone: input.contactPhone ?? null,
          contactEmail: input.contactEmail ?? null,
          country: input.country ?? null,
          notes: input.notes ?? null,
        });
      }

      const licenseKey = this.generateKey();
      const license = this.store.createLicense({
        restaurantId: restaurant.restaurant_id,
        keyHash: hashToken(licenseKey),
        keyHint: licenseKey.slice(-5),
        licenseType: input.licenseType ?? LicenseType.PERPETUAL,
        licenseYear: this.licenseYear,
        notes: input.notes ?? null,
      });

      this.store.audit({
        actor: input.actor,
        action: 'license.issued',
        licenseId: license.license_id,
        restaurantId: restaurant.restaurant_id,
        detail: { licenseType: license.license_type, keyHint: license.key_hint },
        clientIp: input.clientIp ?? null,
      });

      return { license, restaurant, licenseKey };
    });
  }

  /* ---------------------------------------------------------- activation */

  private lookupByKey(rawKey: string): LicenseRow {
    const normalised = normaliseLicenseKey(rawKey);
    if (!normalised) {
      throw licenseError(LicenseErrorCode.INVALID_KEY_FORMAT, 400,
        'license key is malformed or its checksum does not match');
    }
    const license = this.store.getLicenseByKeyHash(hashToken(normalised));
    if (!license) {
      // Deliberately identical wording to a format failure would help an
      // attacker enumerate keys; the checksum already blocks random guessing,
      // so being specific here is a support win, not a security loss.
      throw licenseError(LicenseErrorCode.UNKNOWN_KEY, 404, 'no licence matches this key');
    }
    return license;
  }

  activate(request: ActivationRequest, clientIp: string | null): ActivationResponse {
    const signing = this.requireSigning();

    return this.store.tx(() => {
      const license = this.lookupByKey(request.licenseKey);
      const restaurant = this.store.getRestaurant(license.restaurant_id);
      if (!restaurant) throw licenseError(ErrorCode.INTERNAL, 500, 'licence has no restaurant');

      if (license.status === LicenseStatus.REVOKED) {
        throw licenseError(LicenseErrorCode.REVOKED, 403, 'this licence has been revoked');
      }

      // An installation that already knows its identity must not be able to
      // attach a different restaurant's licence to its data (spec §4).
      if (request.restaurantId && request.restaurantId !== license.restaurant_id) {
        throw licenseError(LicenseErrorCode.RESTAURANT_MISMATCH, 409,
          'this licence belongs to a different restaurant');
      }

      const live = this.store.liveActivation(license.license_id);
      const history = this.store.activationHistory(license.license_id);
      let transferred = false;

      if (live && live.device_fingerprint === request.deviceFingerprint) {
        // Same machine re-activating: refresh the binding, charge nothing.
        this.store.releaseActivation(live.id, 'reactivated on the same device');
      } else if (live) {
        throw licenseError(LicenseErrorCode.ALREADY_ACTIVE_ELSEWHERE, 409,
          'this licence is active on another device; deactivate it first');
      } else if (license.status !== LicenseStatus.PENDING) {
        // No live binding and the licence has been activated before. A transfer
        // fee is for *moving hardware*, so it is charged only when this is a
        // different machine from the one that last held the licence. Coming
        // back to the same PC — after a change of mind, or after the vendor
        // revoked and reinstated — must be free, or the restaurant would be
        // billed for something it never did.
        const lastDevice = history[0]?.device_fingerprint ?? null;
        const sameMachine = lastDevice === request.deviceFingerprint;

        if (!sameMachine) {
          if (license.transfer_credits <= 0) {
            throw licenseError(LicenseErrorCode.TRANSFER_NOT_PAID, 402,
              'moving this licence to a new device requires a licence transfer');
          }
          transferred = true;
        }
      }

      const previousFingerprint = history
        .find((a) => a.device_fingerprint !== request.deviceFingerprint)?.device_fingerprint ?? null;

      const activation = this.store.insertActivation({
        licenseId: license.license_id,
        deviceFingerprint: request.deviceFingerprint,
        deviceLabel: request.deviceLabel || null,
        appVersion: request.appVersion || null,
        clientIp,
      });

      const transferCount = transferred ? license.transfer_count + 1 : license.transfer_count;

      this.store.updateLicense(license.license_id, {
        status: LicenseStatus.ACTIVE,
        activated_at: license.activated_at ?? activation.activated_at,
        app_version: request.appVersion || license.app_version,
        transfer_count: transferCount,
        ...(transferred ? { transfer_credits: license.transfer_credits - 1 } : {}),
      });

      if (transferred) {
        this.store.insertTransfer({
          licenseId: license.license_id,
          fromFingerprint: previousFingerprint,
          toFingerprint: request.deviceFingerprint,
          reason: 'device transfer',
          feeReference: null,
          performedBy: 'activation',
        });
      }

      this.store.audit({
        actor: 'installation',
        action: transferred ? 'license.transferred' : 'license.activated',
        licenseId: license.license_id,
        restaurantId: license.restaurant_id,
        detail: {
          deviceFingerprint: request.deviceFingerprint,
          deviceLabel: request.deviceLabel,
          appVersion: request.appVersion,
          transferCount,
        },
        clientIp,
      });

      const certificate = this.buildCertificate({
        license: { ...license, transfer_count: transferCount },
        restaurantName: restaurant.name,
        deviceFingerprint: request.deviceFingerprint as DeviceFingerprint,
        activationId: activation.id,
        appVersion: request.appVersion,
        signing,
      });

      return {
        certificate,
        nonce: request.nonce,
        restaurantId: license.restaurant_id as RestaurantId,
        licenseId: license.license_id as LicenseId,
      };
    });
  }

  private buildCertificate(input: {
    license: LicenseRow;
    restaurantName: string;
    deviceFingerprint: DeviceFingerprint;
    activationId: string;
    appVersion: string;
    signing: SigningMaterial;
  }): ActivationCertificate {
    const payload: ActivationCertificatePayload = {
      v: ACTIVATION_CERTIFICATE_VERSION,
      licenseId: input.license.license_id as LicenseId,
      licenseType: input.license.license_type,
      restaurantId: input.license.restaurant_id as RestaurantId,
      restaurantName: input.restaurantName,
      deviceFingerprint: input.deviceFingerprint,
      activationId: input.activationId,
      issuedAt: new Date().toISOString(),
      transferCount: input.license.transfer_count,
      appVersion: input.appVersion,
      // Perpetual: the certificate never stops being valid (spec §5).
      notAfter: null,
      features: [...LICENSED_CAPABILITIES],
    };
    return issueCertificate(payload, input.signing.privateKey, input.signing.publicKey);
  }

  /* -------------------------------------------------------- deactivation */

  /** Called by the installation itself, before the owner moves to a new PC. */
  deactivate(request: DeactivationRequest, clientIp: string | null): DeactivationResponse {
    return this.store.tx(() => {
      const license = this.lookupByKey(request.licenseKey);
      const live = this.store.liveActivation(license.license_id);

      if (!live) {
        throw licenseError(LicenseErrorCode.NOT_ACTIVE, 409,
          'this licence has no active device binding');
      }
      if (live.device_fingerprint !== request.deviceFingerprint) {
        throw licenseError(LicenseErrorCode.DEVICE_MISMATCH, 403,
          'this device does not hold the active binding for this licence');
      }

      this.store.releaseActivation(live.id, request.reason || 'deactivated by the installation');
      this.store.updateLicense(license.license_id, { status: LicenseStatus.DEACTIVATED });
      this.store.audit({
        actor: 'installation',
        action: 'license.deactivated',
        licenseId: license.license_id,
        restaurantId: license.restaurant_id,
        detail: { deviceFingerprint: request.deviceFingerprint, reason: request.reason },
        clientIp,
      });

      return {
        licenseId: license.license_id as LicenseId,
        status: LicenseStatus.DEACTIVATED,
        nonce: request.nonce,
      };
    });
  }

  /**
   * Vendor-side release, for the case the spec calls out explicitly: the old
   * computer is dead, stolen or sold and cannot deactivate itself (spec §6).
   */
  adminReleaseDevice(licenseId: string, reason: string, actor: string, clientIp: string | null): void {
    this.store.tx(() => {
      const license = this.store.getLicense(licenseId);
      if (!license) throw licenseError(ErrorCode.NOT_FOUND, 404, 'licence not found');

      const live = this.store.liveActivation(licenseId);
      if (live) this.store.releaseActivation(live.id, `released by ${actor}: ${reason}`);

      this.store.updateLicense(licenseId, { status: LicenseStatus.DEACTIVATED });
      this.store.audit({
        actor,
        action: 'license.admin_released',
        licenseId,
        restaurantId: license.restaurant_id,
        detail: { reason, releasedFingerprint: live?.device_fingerprint ?? null },
        clientIp,
      });
    });
  }

  revoke(licenseId: string, reason: string, actor: string, clientIp: string | null): void {
    this.store.tx(() => {
      const license = this.store.getLicense(licenseId);
      if (!license) throw licenseError(ErrorCode.NOT_FOUND, 404, 'licence not found');

      const live = this.store.liveActivation(licenseId);
      if (live) this.store.releaseActivation(live.id, `revoked by ${actor}: ${reason}`);

      this.store.updateLicense(licenseId, { status: LicenseStatus.REVOKED, transfer_credits: 0 });
      this.store.audit({
        actor, action: 'license.revoked', licenseId,
        restaurantId: license.restaurant_id, detail: { reason }, clientIp,
      });
    });
  }

  /** Undo a revocation, e.g. after a payment dispute is settled. */
  reinstate(licenseId: string, reason: string, actor: string, clientIp: string | null): void {
    this.store.tx(() => {
      const license = this.store.getLicense(licenseId);
      if (!license) throw licenseError(ErrorCode.NOT_FOUND, 404, 'licence not found');
      if (license.status !== LicenseStatus.REVOKED) {
        throw licenseError(ErrorCode.CONFLICT, 409, 'only a revoked licence can be reinstated');
      }
      // Back to DEACTIVATED, not ACTIVE: the restaurant must activate a device
      // again, which is what re-establishes the binding.
      this.store.updateLicense(licenseId, { status: LicenseStatus.DEACTIVATED });
      this.store.audit({
        actor, action: 'license.reinstated', licenseId,
        restaurantId: license.restaurant_id, detail: { reason }, clientIp,
      });
    });
  }

  /**
   * Record that a transfer fee was settled, granting one move to a new device.
   * `feeReference` is the vendor's own invoice/receipt id — this server takes
   * no payments itself.
   */
  grantTransferCredit(
    licenseId: string,
    feeReference: string | null,
    actor: string,
    clientIp: string | null,
  ): void {
    this.store.tx(() => {
      const license = this.store.getLicense(licenseId);
      if (!license) throw licenseError(ErrorCode.NOT_FOUND, 404, 'licence not found');
      if (license.status === LicenseStatus.REVOKED) {
        throw licenseError(LicenseErrorCode.REVOKED, 403, 'a revoked licence cannot be transferred');
      }

      this.store.updateLicense(licenseId, { transfer_credits: license.transfer_credits + 1 });
      this.store.insertTransfer({
        licenseId,
        fromFingerprint: this.store.liveActivation(licenseId)?.device_fingerprint ?? null,
        toFingerprint: null,
        reason: 'transfer fee settled',
        feeReference,
        performedBy: actor,
      });
      this.store.audit({
        actor, action: 'license.transfer_credit_granted', licenseId,
        restaurantId: license.restaurant_id, detail: { feeReference }, clientIp,
      });
    });
  }

  /* -------------------------------------------------------------- status */

  statusByKey(licenseKey: string): {
    licenseId: string;
    restaurantId: string;
    restaurantName: string;
    status: string;
    licenseType: string;
    boundDeviceFingerprint: string | null;
    activatedAt: string | null;
    transferCount: number;
    transferCredits: number;
  } {
    const license = this.lookupByKey(licenseKey);
    const restaurant = this.store.getRestaurant(license.restaurant_id);
    const live = this.store.liveActivation(license.license_id);
    return {
      licenseId: license.license_id,
      restaurantId: license.restaurant_id,
      restaurantName: restaurant?.name ?? '',
      status: license.status,
      licenseType: license.license_type,
      boundDeviceFingerprint: live?.device_fingerprint ?? null,
      activatedAt: license.activated_at,
      transferCount: license.transfer_count,
      transferCredits: license.transfer_credits,
    };
  }

  /* -------------------------------------------------------- vendor info */

  /**
   * What a restaurant is shown on its licence screen. The vendor writes every
   * word of it, including both prices: the application never quotes a figure
   * of its own, and never takes a payment.
   */
  vendorInfo(): VendorInfo {
    return this.store.getSetting<VendorInfo>(VENDOR_INFO_KEY, EMPTY_VENDOR_INFO);
  }

  saveVendorInfo(input: unknown, actor: string, clientIp: string | null): VendorInfo {
    const info = parseVendorInfo(input);
    this.store.setSetting(VENDOR_INFO_KEY, info);
    this.store.audit({
      actor,
      action: 'vendor.info_updated',
      detail: {
        contacts: info.contacts.length,
        activation: info.pricing.activation.price,
        transfer: info.pricing.transfer.price,
      },
      clientIp,
    });
    return info;
  }

  /** Publish the vendor public keys so an installer can pin them out of band. */
  publicKeys(): { keyId: string; publicKey: string }[] {
    return this.store.listSigningKeys()
      .filter((k) => k.active === 1)
      .map((k) => ({ keyId: k.key_id, publicKey: k.public_key }));
  }

  registerOwnKey(): void {
    if (!this.signing) return;
    const keyId = computeKeyId(this.signing.publicKey);
    this.store.upsertSigningKey(keyId, this.signing.publicKey);
  }

  static newNonce(): string {
    return monotonicCode(12);
  }
}

const VENDOR_INFO_KEY = 'vendor.info';

/**
 * Coerce whatever the vendor console posted into the published shape. Text is
 * trimmed and length-capped, because this is rendered on a restaurant's screen
 * and a runaway paste should not be able to break the licence page.
 */
export function parseVendorInfo(input: unknown): VendorInfo {
  const body = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const pricing = (typeof body['pricing'] === 'object' && body['pricing'] !== null
    ? body['pricing']
    : {}) as Record<string, unknown>;

  const rawContacts = Array.isArray(body['contacts']) ? body['contacts'] : [];
  const contacts: VendorContact[] = [];
  for (const entry of rawContacts.slice(0, 12)) {
    const contact = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const value = text(contact['value'], 200);
    if (value === '') continue;
    const kind = String(contact['kind'] ?? '').toUpperCase();
    contacts.push({
      kind: (kind in VendorContactKind ? kind : VendorContactKind.OTHER) as VendorContactKind,
      label: text(contact['label'], 60),
      value,
    });
  }

  return {
    vendorName: text(body['vendorName'], 80),
    tagline: textOrNull(body['tagline'], 160),
    contacts,
    pricing: {
      activation: price(pricing['activation']),
      transfer: price(pricing['transfer']),
    },
    instructions: textOrNull(body['instructions'], 2000),
    updatedAt: new Date().toISOString(),
  };
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const textOrNull = (value: unknown, max: number): string | null => text(value, max) || null;

const price = (value: unknown): { price: string; note: string | null } => {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { price: text(entry['price'], 80), note: textOrNull(entry['note'], 300) };
};
