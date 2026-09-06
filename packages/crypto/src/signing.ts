/**
 * Ed25519 signing (spec §28).
 *
 * The vendor holds the private key on the license server and nowhere else. The
 * distributed application ships only public keys, so a copy of the app contains
 * nothing that can mint a licence. Keys are identified by `keyId` (a hash of
 * the public key) so the vendor can rotate without invalidating certificates
 * already in the field: an installation keeps verifying with the key that
 * signed it, as long as that key is still in its trust store.
 */

import {
  createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign,
  verify as nodeVerify, type KeyObject,
} from 'node:crypto';
import { fromBase64Url, toBase64Url } from './encoding.js';
import { sha256 } from './hash.js';

/** DER prefixes for raw Ed25519 keys, so key material can travel as 32 bytes. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const RAW_KEY_LENGTH = 32;

export interface KeyPairMaterial {
  /** base64url of the raw 32-byte public key. Safe to ship in the app. */
  readonly publicKey: string;
  /** base64url of the raw 32-byte seed. Vendor secret — never leaves the server. */
  readonly privateKey: string;
  readonly keyId: string;
}

/** Short, stable identifier for a public key: first 16 hex chars of its SHA-256. */
export function computeKeyId(publicKeyBase64Url: string): string {
  return sha256(fromBase64Url(publicKeyBase64Url)).toString('hex').slice(0, 16);
}

export function generateSigningKeyPair(): KeyPairMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });

  const rawPublic = spki.subarray(spki.length - RAW_KEY_LENGTH);
  const rawPrivate = pkcs8.subarray(pkcs8.length - RAW_KEY_LENGTH);

  const publicB64 = toBase64Url(rawPublic);
  return {
    publicKey: publicB64,
    privateKey: toBase64Url(rawPrivate),
    keyId: computeKeyId(publicB64),
  };
}

export function publicKeyFromRaw(base64UrlKey: string): KeyObject {
  const raw = fromBase64Url(base64UrlKey);
  if (raw.length !== RAW_KEY_LENGTH) {
    throw new Error(`ed25519 public key must be ${RAW_KEY_LENGTH} bytes, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function privateKeyFromRaw(base64UrlKey: string): KeyObject {
  const raw = fromBase64Url(base64UrlKey);
  if (raw.length !== RAW_KEY_LENGTH) {
    throw new Error(`ed25519 private key must be ${RAW_KEY_LENGTH} bytes, got ${raw.length}`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Signs the UTF-8 bytes of `message`. Returns base64url. */
export function signMessage(message: string, privateKeyBase64Url: string): string {
  const key = privateKeyFromRaw(privateKeyBase64Url);
  return toBase64Url(nodeSign(null, Buffer.from(message, 'utf8'), key));
}

/** Never throws: a malformed key or signature is simply "not valid". */
export function verifyMessage(
  message: string,
  signatureBase64Url: string,
  publicKeyBase64Url: string,
): boolean {
  try {
    const key = publicKeyFromRaw(publicKeyBase64Url);
    return nodeVerify(
      null,
      Buffer.from(message, 'utf8'),
      key,
      fromBase64Url(signatureBase64Url),
    );
  } catch {
    return false;
  }
}

/**
 * The set of vendor public keys an installation trusts. Shipped as a plain JSON
 * file inside the app; holding several entries is what makes rotation painless.
 */
export interface TrustStore {
  readonly keys: Readonly<Record<string, string>>;
}

export function verifyWithTrustStore(
  message: string,
  signatureBase64Url: string,
  keyId: string,
  trust: TrustStore,
): boolean {
  const publicKey = trust.keys[keyId];
  if (!publicKey) return false;
  return verifyMessage(message, signatureBase64Url, publicKey);
}
