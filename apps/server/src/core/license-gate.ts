/**
 * The licence gate (spec §2, §38, §52).
 *
 * This is the single place that decides whether the installation is in SETUP or
 * OPERATIONAL mode, and it decides it *offline*. At boot it reads the stored
 * activation certificate, verifies the Ed25519 signature against the public
 * keys shipped with the app, and checks that the certificate names this device
 * and this restaurant. There is no network call on this path and none on any
 * later request, so a vendor outage or an unplugged router cannot close a
 * restaurant.
 *
 * The gate is enforced twice, deliberately:
 *
 *  1. Route level — `requireCapability` refuses the request.
 *  2. Listener level — the LAN server is not bound at all until the mode is
 *     OPERATIONAL. Before activation there is no socket for a diner's phone to
 *     connect to, which is a stronger guarantee than any check inside a handler.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import {
  Capability, CertificateVerdict, capabilitiesForMode, isCapabilityAvailable,
  licenseRequired, RestaurantMode,
  type ActivationCertificate, type ActivationCertificatePayload,
  type DeviceFingerprint, type RestaurantId,
} from '@qserve/shared';
import { verifyCertificate, type TrustStore } from '@qserve/crypto';
import type { LicenseRepository } from './repositories/license.js';
import type { Paths } from './paths.js';

export interface LicenseSnapshot {
  readonly mode: RestaurantMode;
  readonly verdict: CertificateVerdict;
  readonly capabilities: readonly Capability[];
  readonly payload: ActivationCertificatePayload | null;
}

export function loadTrustStore(file: string): TrustStore {
  if (!existsSync(file)) {
    // A build without a trust store can still run in SETUP mode, which is the
    // right behaviour for a developer checkout — but it can never activate.
    return { keys: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as TrustStore;
    return typeof parsed.keys === 'object' && parsed.keys !== null ? parsed : { keys: {} };
  } catch {
    return { keys: {} };
  }
}

export class LicenseGate {
  private snapshot: LicenseSnapshot = {
    mode: RestaurantMode.SETUP,
    verdict: CertificateVerdict.MISSING,
    capabilities: capabilitiesForMode(RestaurantMode.SETUP),
    payload: null,
  };

  private readonly listeners = new Set<(snapshot: LicenseSnapshot) => void>();

  constructor(
    private readonly repository: LicenseRepository,
    private readonly paths: Paths,
    private readonly trust: TrustStore,
    private readonly deviceFingerprint: DeviceFingerprint,
  ) {}

  get current(): LicenseSnapshot {
    return this.snapshot;
  }

  get mode(): RestaurantMode {
    return this.snapshot.mode;
  }

  onChange(listener: (snapshot: LicenseSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Read the certificate from disk. Null when this installation has none. */
  readStoredCertificate(): ActivationCertificate | null {
    if (!existsSync(this.paths.certificateFile)) return null;
    try {
      return JSON.parse(readFileSync(this.paths.certificateFile, 'utf8')) as ActivationCertificate;
    } catch {
      return null;
    }
  }

  /**
   * Re-evaluate the licence. Called at boot, after activation, and after a
   * restore. Pure local computation.
   */
  evaluate(expectedRestaurantId?: RestaurantId | null): LicenseSnapshot {
    const certificate = this.readStoredCertificate();
    const check = verifyCertificate(certificate, this.trust, {
      deviceFingerprint: this.deviceFingerprint,
      ...(expectedRestaurantId ? { restaurantId: expectedRestaurantId } : {}),
    });

    const mode = check.verdict === CertificateVerdict.VALID
      ? RestaurantMode.OPERATIONAL
      : RestaurantMode.SETUP;

    this.snapshot = {
      mode,
      verdict: check.verdict,
      capabilities: capabilitiesForMode(mode),
      payload: check.payload ?? null,
    };

    this.repository.saveVerdict({
      verdict: check.verdict,
      payload: check.payload ?? null,
    });

    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
  }

  /** Persist a freshly issued certificate, then re-evaluate. */
  installCertificate(
    certificate: ActivationCertificate,
    expectedRestaurantId?: RestaurantId | null,
  ): LicenseSnapshot {
    writeFileSync(this.paths.certificateFile, `${JSON.stringify(certificate, null, 2)}\n`, {
      mode: 0o600,
    });
    return this.evaluate(expectedRestaurantId ?? null);
  }

  /** Remove the local certificate after a successful deactivation. */
  clearCertificate(): LicenseSnapshot {
    rmSync(this.paths.certificateFile, { force: true });
    rmSync(this.paths.licenseKeyFile, { force: true });
    return this.evaluate(null);
  }

  has(capability: Capability): boolean {
    return isCapabilityAvailable(this.snapshot.mode, capability);
  }

  /** Throws a 402 carrying the capability name, which the UI turns into the
   *  "activate your licence" prompt rather than a generic error. */
  assert(capability: Capability): void {
    if (!this.has(capability)) throw licenseRequired(capability);
  }

  /**
   * Human-readable explanation of why the installation is in SETUP. Shown on
   * the licence screen so an owner is never left guessing.
   */
  explain(): string {
    switch (this.snapshot.verdict) {
      case CertificateVerdict.VALID: return 'license.state.active';
      case CertificateVerdict.MISSING: return 'license.state.not_activated';
      case CertificateVerdict.DEVICE_MISMATCH: return 'license.state.device_changed';
      case CertificateVerdict.RESTAURANT_MISMATCH: return 'license.state.restaurant_mismatch';
      case CertificateVerdict.BAD_SIGNATURE: return 'license.state.signature_invalid';
      case CertificateVerdict.UNKNOWN_KEY_ID: return 'license.state.unknown_key';
      case CertificateVerdict.UNSUPPORTED_VERSION: return 'license.state.version_unsupported';
      case CertificateVerdict.EXPIRED: return 'license.state.expired';
      default: return 'license.state.invalid';
    }
  }
}
