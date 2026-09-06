/**
 * Wire contract between a restaurant installation and the central license
 * server (spec §26–§28), and the shape of the offline activation certificate.
 *
 * Design rule: the restaurant server contacts the license server *only* for the
 * operations listed here. Normal service never does. After activation the
 * installation verifies its certificate offline against an embedded public key,
 * so a license server outage cannot stop a restaurant from trading (spec §38).
 */

import type { DeviceFingerprint, LicenseId, RestaurantId } from './ids.js';
import type { LicenseStatus, LicenseType } from './enums.js';

/** Bumped when the certificate payload shape changes incompatibly. */
export const ACTIVATION_CERTIFICATE_VERSION = 1;

/**
 * The signed, self-contained proof that this device may run this restaurant.
 * Stored on disk by the installation and re-verified on every boot — offline.
 */
export interface ActivationCertificatePayload {
  readonly v: number;
  readonly licenseId: LicenseId;
  readonly licenseType: LicenseType;
  readonly restaurantId: RestaurantId;
  readonly restaurantName: string;
  readonly deviceFingerprint: DeviceFingerprint;
  /** Unique per activation; changes on every transfer. Enables replay detection. */
  readonly activationId: string;
  /** ISO-8601 UTC. */
  readonly issuedAt: string;
  /** How many times this licence has moved between machines. */
  readonly transferCount: number;
  /** App version that performed activation, for vendor support. */
  readonly appVersion: string;
  /**
   * Perpetual licences never expire, so this is null. Present so that a future
   * time-limited SKU needs no certificate format change.
   */
  readonly notAfter: string | null;
  /** Capability keys unlocked by this licence. */
  readonly features: readonly string[];
}

/** Detached-signature envelope. `payload` is canonical JSON, signed verbatim. */
export interface SignedEnvelope {
  readonly alg: 'Ed25519';
  /** Identifies which vendor public key verifies this envelope. */
  readonly keyId: string;
  /** Canonical JSON of the payload — signed and stored as an exact string. */
  readonly payload: string;
  /** Base64url Ed25519 signature over the UTF-8 bytes of `payload`. */
  readonly signature: string;
}

export type ActivationCertificate = SignedEnvelope;

/* ------------------------------------------------------------------ requests */

export interface ActivationRequest {
  readonly licenseKey: string;
  readonly deviceFingerprint: DeviceFingerprint;
  /** Human-readable machine label, purely for the vendor's support console. */
  readonly deviceLabel: string;
  readonly appVersion: string;
  /**
   * Present when re-activating an installation that already knows its identity
   * (for example after a restore). The server rejects a mismatch rather than
   * silently rebinding the licence to a different restaurant.
   */
  readonly restaurantId?: RestaurantId;
  /** Set at first activation when the vendor has not pre-named the restaurant. */
  readonly restaurantName?: string;
  /** Anti-replay: random, single-use, echoed in the response. */
  readonly nonce: string;
}

export interface ActivationResponse {
  readonly certificate: ActivationCertificate;
  readonly nonce: string;
  readonly restaurantId: RestaurantId;
  readonly licenseId: LicenseId;
}

export interface DeactivationRequest {
  readonly licenseKey: string;
  readonly deviceFingerprint: DeviceFingerprint;
  readonly reason: string;
  readonly nonce: string;
}

export interface DeactivationResponse {
  readonly licenseId: LicenseId;
  readonly status: LicenseStatus;
  readonly nonce: string;
}

/** Read-only status probe, used by the licence screen — never on the hot path. */
export interface LicenseStatusResponse {
  readonly licenseId: LicenseId;
  readonly restaurantId: RestaurantId;
  readonly status: LicenseStatus;
  readonly licenseType: LicenseType;
  readonly boundDeviceFingerprint: DeviceFingerprint | null;
  readonly activatedAt: string | null;
  readonly transferCount: number;
}

/* ------------------------------------------------------- failure vocabulary */

/**
 * Stable machine-readable reasons. The UI maps each to a translation key, so
 * error text is localised without the server ever emitting prose.
 */
export const LicenseErrorCode = {
  INVALID_KEY_FORMAT: 'LICENSE_INVALID_KEY_FORMAT',
  UNKNOWN_KEY: 'LICENSE_UNKNOWN_KEY',
  ALREADY_ACTIVE_ELSEWHERE: 'LICENSE_ALREADY_ACTIVE_ELSEWHERE',
  REVOKED: 'LICENSE_REVOKED',
  RESTAURANT_MISMATCH: 'LICENSE_RESTAURANT_MISMATCH',
  DEVICE_MISMATCH: 'LICENSE_DEVICE_MISMATCH',
  SIGNATURE_INVALID: 'LICENSE_SIGNATURE_INVALID',
  CERTIFICATE_VERSION: 'LICENSE_CERTIFICATE_VERSION',
  SERVER_UNREACHABLE: 'LICENSE_SERVER_UNREACHABLE',
  TRANSFER_NOT_PAID: 'LICENSE_TRANSFER_NOT_PAID',
  NOT_ACTIVE: 'LICENSE_NOT_ACTIVE',
} as const;
export type LicenseErrorCode = (typeof LicenseErrorCode)[keyof typeof LicenseErrorCode];

/** Why a locally held certificate was refused at boot. */
export const CertificateVerdict = {
  VALID: 'VALID',
  MISSING: 'MISSING',
  MALFORMED: 'MALFORMED',
  BAD_SIGNATURE: 'BAD_SIGNATURE',
  UNKNOWN_KEY_ID: 'UNKNOWN_KEY_ID',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  DEVICE_MISMATCH: 'DEVICE_MISMATCH',
  RESTAURANT_MISMATCH: 'RESTAURANT_MISMATCH',
  EXPIRED: 'EXPIRED',
} as const;
export type CertificateVerdict = (typeof CertificateVerdict)[keyof typeof CertificateVerdict];
