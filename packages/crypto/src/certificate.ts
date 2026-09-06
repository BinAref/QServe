/**
 * Activation certificate: issue on the license server, verify offline on the
 * restaurant PC (spec §28, §38).
 *
 * The verification path deliberately performs no I/O. That is the property that
 * lets a restaurant keep trading when the vendor's server is down, the internet
 * is out, or the vendor has gone to bed.
 */

import {
  ACTIVATION_CERTIFICATE_VERSION, CertificateVerdict,
  type ActivationCertificate, type ActivationCertificatePayload,
  type DeviceFingerprint, type RestaurantId,
} from '@qserve/shared';
import { canonicalJson } from './canonical-json.js';
import { computeKeyId, signMessage, verifyWithTrustStore, type TrustStore } from './signing.js';

export function issueCertificate(
  payload: ActivationCertificatePayload,
  privateKeyBase64Url: string,
  publicKeyBase64Url: string,
): ActivationCertificate {
  const canonical = canonicalJson(payload);
  return {
    alg: 'Ed25519',
    keyId: computeKeyId(publicKeyBase64Url),
    payload: canonical,
    signature: signMessage(canonical, privateKeyBase64Url),
  };
}

export interface CertificateCheck {
  readonly verdict: CertificateVerdict;
  /** Present only when the verdict is VALID. */
  readonly payload?: ActivationCertificatePayload;
}

export interface CertificateExpectations {
  readonly deviceFingerprint: DeviceFingerprint;
  /**
   * The restaurant this installation believes it is. Checked so that restoring
   * one restaurant's backup onto another's licence fails loudly (spec §4).
   */
  readonly restaurantId?: RestaurantId;
  readonly now?: Date;
}

export function verifyCertificate(
  certificate: ActivationCertificate | null | undefined,
  trust: TrustStore,
  expect: CertificateExpectations,
): CertificateCheck {
  if (!certificate) return { verdict: CertificateVerdict.MISSING };

  if (
    typeof certificate.payload !== 'string' ||
    typeof certificate.signature !== 'string' ||
    typeof certificate.keyId !== 'string' ||
    certificate.alg !== 'Ed25519'
  ) {
    return { verdict: CertificateVerdict.MALFORMED };
  }

  if (!(certificate.keyId in trust.keys)) {
    return { verdict: CertificateVerdict.UNKNOWN_KEY_ID };
  }

  // Signature first: nothing inside the payload is trusted until it verifies.
  if (!verifyWithTrustStore(certificate.payload, certificate.signature, certificate.keyId, trust)) {
    return { verdict: CertificateVerdict.BAD_SIGNATURE };
  }

  let payload: ActivationCertificatePayload;
  try {
    payload = JSON.parse(certificate.payload) as ActivationCertificatePayload;
  } catch {
    return { verdict: CertificateVerdict.MALFORMED };
  }

  if (payload.v !== ACTIVATION_CERTIFICATE_VERSION) {
    return { verdict: CertificateVerdict.UNSUPPORTED_VERSION };
  }

  if (payload.deviceFingerprint !== expect.deviceFingerprint) {
    return { verdict: CertificateVerdict.DEVICE_MISMATCH };
  }

  if (expect.restaurantId && payload.restaurantId !== expect.restaurantId) {
    return { verdict: CertificateVerdict.RESTAURANT_MISMATCH };
  }

  // Perpetual licences carry notAfter === null and never take this branch.
  if (payload.notAfter !== null) {
    const now = expect.now ?? new Date();
    const notAfter = new Date(payload.notAfter);
    if (Number.isNaN(notAfter.getTime()) || notAfter.getTime() < now.getTime()) {
      return { verdict: CertificateVerdict.EXPIRED };
    }
  }

  return { verdict: CertificateVerdict.VALID, payload };
}
