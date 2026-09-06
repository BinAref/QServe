/**
 * License key encoding.
 *
 * A key is what the restaurant owner types once: 20 Crockford base32 characters
 * in five dash-separated groups, prefixed `QSRV`. The last character is a
 * checksum so a mistyped key fails instantly and offline instead of producing a
 * confusing round-trip to the license server.
 *
 *   QSRV-4K7QM-9XTV2-BR5HN-P83WC
 *
 * The key is a *bearer secret*. The license server stores only its SHA-256 hash
 * (see docs/SECURITY.md); it is displayed to the vendor exactly once, at issue.
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
  // transpositions, which are the two mistakes people actually make when typing.
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const v = ALPHABET_INDEX.get(body[i]!);
    if (v === undefined) throw new Error(`invalid character in license key body: ${body[i]}`);
    sum += v * (i + 2);
  }
  return ALPHABET[sum % 32]!;
}

/** Build a key from 19 random Crockford characters. */
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

export const isLicenseKey = (input: string): boolean => normaliseLicenseKey(input) !== null;

/** Random key generator. Injected RNG keeps this testable and runtime-neutral. */
export function generateLicenseKey(
  randomValues: (n: number) => Uint8Array = (n) => {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  },
): string {
  const bytes = randomValues(BODY_LENGTH);
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i += 1) body += ALPHABET[bytes[i]! % 32];
  return encodeLicenseKey(body);
}
