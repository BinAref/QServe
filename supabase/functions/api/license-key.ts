/**
 * License key encoding — a copy of `packages/shared/src/license-key.ts`.
 *
 * Copied rather than shared because this file runs in Deno, inside Supabase,
 * with no access to the repository's packages. It is copied *exactly* for the
 * same reason the crypto is: a key typed by a restaurant owner is normalised
 * here and was hashed by the vendor console there, and the two have to agree
 * character for character or a perfectly good key stops working.
 *
 *   QSRV-4K7QM-9XTV2-BR5HN-P83WC
 *
 * The key is a bearer secret. Only its SHA-256 hash is ever stored.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ALPHABET_INDEX: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((c, i) => [c, i]),
);

export const LICENSE_KEY_PREFIX = 'QSRV';
const BODY_LENGTH = 19; // 19 payload chars + 1 checksum char = 20
const GROUP_SIZE = 5;

/** Characters people habitually substitute, normalised before decoding. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  I: '1', L: '1', O: '0', U: 'V',
};

function checksumChar(body: string): string {
  // Weighted mod-32 sum: catches every single-character error and all adjacent
  // transpositions, which are the two mistakes people actually make.
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const v = ALPHABET_INDEX.get(body[i]!);
    if (v === undefined) throw new Error(`invalid character in license key body: ${body[i]}`);
    sum += v * (i + 2);
  }
  return ALPHABET[sum % 32]!;
}

export function encodeLicenseKey(body: string): string {
  const upper = body.toUpperCase();
  if (upper.length !== BODY_LENGTH) {
    throw new RangeError(`license key body must be ${BODY_LENGTH} characters`);
  }
  const full = upper + checksumChar(upper);
  const groups: string[] = [];
  for (let i = 0; i < full.length; i += GROUP_SIZE) {
    groups.push(full.slice(i, i + GROUP_SIZE));
  }
  return [LICENSE_KEY_PREFIX, ...groups].join('-');
}

/**
 * Normalise user input to canonical form, or return null if it is not a valid
 * key. Accepts lower case, missing dashes, extra whitespace and confusables.
 */
export function normaliseLicenseKey(input: string): string | null {
  let cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (cleaned.startsWith(LICENSE_KEY_PREFIX)) {
    cleaned = cleaned.slice(LICENSE_KEY_PREFIX.length);
  }
  cleaned = [...cleaned].map((c) => CONFUSABLES[c] ?? c).join('');
  if (cleaned.length !== BODY_LENGTH + 1) return null;

  const body = cleaned.slice(0, BODY_LENGTH);
  const check = cleaned.slice(BODY_LENGTH);
  for (const c of body) if (!ALPHABET_INDEX.has(c)) return null;
  if (checksumChar(body) !== check) return null;

  return encodeLicenseKey(body);
}

export function generateLicenseKey(): string {
  const bytes = new Uint8Array(BODY_LENGTH);
  crypto.getRandomValues(bytes);
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i += 1) body += ALPHABET[bytes[i]! % 32];
  return encodeLicenseKey(body);
}
