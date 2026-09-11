/**
 * The signing half of the licence server, on Deno's WebCrypto.
 *
 * This is a port of `packages/crypto`, and the word that matters is *port*: a
 * certificate signed here is verified on a restaurant's own computer by code
 * that ships inside the application and has never met this file. If the bytes
 * disagree by one character the restaurant sees "this licence is not valid",
 * so the two implementations have to produce identical output, not merely
 * equivalent output.
 *
 * Three things are therefore copied exactly rather than rewritten:
 *
 *   - the canonical JSON rules (sorted keys, no whitespace, `undefined`
 *     dropped), because a signature is over bytes and `JSON.stringify` does not
 *     promise key order;
 *   - the raw-32-byte key encoding, wrapped in the same DER prefixes;
 *   - the key id, being the first 16 hex characters of the public key's
 *     SHA-256.
 *
 * `supabase/functions/api/parity.test.ts` in the repository checks this claim
 * against the Node implementation rather than trusting it.
 */

/* ------------------------------------------------------------- encoding */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ----------------------------------------------------------- canonical */

/**
 * Deterministic JSON. Keys sorted by Unicode code point, no insignificant
 * whitespace, `undefined` members dropped. The signed artefact is kept as the
 * *string* this produces and never re-serialised from a parsed object, so
 * verification cannot drift.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('cannot canonicalise a non-finite number');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('cannot canonicalise a bigint');
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`cannot canonicalise a ${typeof value}`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }

  const object = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const member = object[key];
    if (member === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${parts.join(',')}}`;
}

/* -------------------------------------------------------------- hashing */

export async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return toHex(await sha256(input));
}

/** Bearer secrets are stored hashed: a database dump cannot be replayed. */
export const hashToken = (token: string): Promise<string> => sha256Hex(token);

/* ------------------------------------------------------------- Ed25519 */

/** DER prefix for a raw 32-byte Ed25519 private key, so it travels as 32 bytes. */
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b,
  0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const RAW_KEY_LENGTH = 32;

/** The first 16 hex characters of the public key's SHA-256. */
export async function computeKeyId(publicKeyBase64Url: string): Promise<string> {
  return (await sha256Hex(fromBase64Url(publicKeyBase64Url))).slice(0, 16);
}

async function importPrivateKey(privateKeyBase64Url: string): Promise<CryptoKey> {
  const raw = fromBase64Url(privateKeyBase64Url);
  if (raw.length !== RAW_KEY_LENGTH) {
    throw new Error(`ed25519 private key must be ${RAW_KEY_LENGTH} bytes, got ${raw.length}`);
  }
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + raw.length);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.set(raw, PKCS8_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

/** Signs the UTF-8 bytes of `message`. Returns base64url. */
export async function signMessage(
  message: string,
  privateKeyBase64Url: string,
): Promise<string> {
  const key = await importPrivateKey(privateKeyBase64Url);
  const signature = await crypto.subtle.sign(
    'Ed25519', key, new TextEncoder().encode(message),
  );
  return toBase64Url(new Uint8Array(signature));
}

export interface ActivationCertificate {
  readonly alg: 'Ed25519';
  readonly keyId: string;
  readonly payload: string;
  readonly signature: string;
}

export async function issueCertificate(
  payload: Record<string, unknown>,
  privateKeyBase64Url: string,
  publicKeyBase64Url: string,
): Promise<ActivationCertificate> {
  const canonical = canonicalJson(payload);
  return {
    alg: 'Ed25519',
    keyId: await computeKeyId(publicKeyBase64Url),
    payload: canonical,
    signature: await signMessage(canonical, privateKeyBase64Url),
  };
}
