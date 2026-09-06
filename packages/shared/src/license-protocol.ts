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

/* ------------------------------------------------------------- vendor info */

/**
 * How a restaurant reaches whoever sells it a licence, and what that costs.
 *
 * The application handles no payment at all. Someone who wants a licence talks
 * to the vendor — on WhatsApp, on the phone, by email — pays however the two of
 * them agree, and is given a key to type in. So the only thing the software
 * needs to know is *who to contact and what to expect to pay*, and both of
 * those are the vendor's to write, not the developer's to hard-code and not the
 * restaurant's to guess.
 *
 * The prices are free text on purpose. "1500 SAR", "‏٥٠٠ ر.س شامل التركيب",
 * "first transfer free" — a vendor selling in three countries can say what is
 * true, which a number and a currency code cannot.
 */
export interface VendorContact {
  readonly kind: VendorContactKind;
  /** What to show, e.g. "Sales" or "Support (Arabic)". */
  readonly label: string;
  /** The number, address or handle itself. */
  readonly value: string;
}

export const VendorContactKind = {
  WHATSAPP: 'WHATSAPP',
  PHONE: 'PHONE',
  EMAIL: 'EMAIL',
  TELEGRAM: 'TELEGRAM',
  WEBSITE: 'WEBSITE',
  OTHER: 'OTHER',
} as const;
export type VendorContactKind = (typeof VendorContactKind)[keyof typeof VendorContactKind];

export interface VendorPrice {
  /** Free text, written by the vendor. Empty means "ask us". */
  readonly price: string;
  readonly note: string | null;
}

export interface VendorInfo {
  readonly vendorName: string;
  readonly tagline: string | null;
  readonly contacts: readonly VendorContact[];
  readonly pricing: {
    /** What a first licence costs. */
    readonly activation: VendorPrice;
    /** What moving a licence to another machine costs (spec §6). */
    readonly transfer: VendorPrice;
  };
  /** Free text shown under the prices: how to pay, opening hours, anything. */
  readonly instructions: string | null;
  readonly updatedAt: string;
}

/** Shown before the vendor has filled anything in, and when offline with no cache. */
export const EMPTY_VENDOR_INFO: VendorInfo = {
  vendorName: '',
  tagline: null,
  contacts: [],
  pricing: {
    activation: { price: '', note: null },
    transfer: { price: '', note: null },
  },
  instructions: null,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/** A tel:/mailto:/wa.me link for a contact, or null when it cannot be linked. */
export function vendorContactUrl(contact: VendorContact, message?: string): string | null {
  const digits = contact.value.replace(/[^\d]/g, '');
  const query = message ? `?text=${encodeURIComponent(message)}` : '';

  switch (contact.kind) {
    case VendorContactKind.WHATSAPP:
      return digits ? `https://wa.me/${digits}${query}` : null;
    case VendorContactKind.PHONE:
      return digits ? `tel:+${digits}` : null;
    case VendorContactKind.EMAIL:
      return contact.value.includes('@') ? `mailto:${contact.value}` : null;
    case VendorContactKind.TELEGRAM: {
      const handle = contact.value.replace(/^@/, '').trim();
      return handle ? `https://t.me/${handle}` : null;
    }
    case VendorContactKind.WEBSITE:
      return /^https?:\/\//i.test(contact.value) ? contact.value : `https://${contact.value}`;
    default:
      return null;
  }
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
