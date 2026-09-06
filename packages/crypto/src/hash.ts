/** Hashing, key derivation and constant-time comparison. */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { toBase64Url } from './encoding.js';

export const sha256Hex = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex');

export const sha256 = (input: string | Uint8Array): Buffer =>
  createHash('sha256').update(input).digest();

/** Comparison that does not leak how many leading bytes matched. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still burn a comparison so the length check is not the only timing signal.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Cost parameters for staff secrets. Staff log in on a tablet behind the
 * restaurant's own Wi-Fi many times a shift, so this is tuned for ~60ms on a
 * modest restaurant PC rather than for offline-crack resistance alone.
 */
const SCRYPT_N = 1 << 15;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** `scrypt$N$r$p$salt$hash`, all base64url. Self-describing so cost can change. */
export function hashSecret(secret: string, salt: Buffer = randomBytes(16)): string {
  const derived = scryptSync(secret.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_r, SCRYPT_p, toBase64Url(salt), toBase64Url(derived)].join('$');
}

export function verifySecret(secret: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const salt = Buffer.from(saltRaw, 'base64url');
  const expected = Buffer.from(hashRaw, 'base64url');
  let derived: Buffer;
  try {
    derived = scryptSync(secret.normalize('NFKC'), salt, expected.length, {
      N, r, p, maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Opaque bearer token for sessions and terminal enrolment. */
export const newToken = (bytes = 32): string => toBase64Url(randomBytes(bytes));

/**
 * Bearer tokens are stored hashed, so a stolen database dump cannot be replayed
 * against a running installation. Plain SHA-256 is right here: the token has
 * full entropy, so there is nothing to brute-force.
 */
export const hashToken = (token: string): string => sha256Hex(token);
