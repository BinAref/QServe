/**
 * Identity primitives.
 *
 * The system keeps six identities strictly separate (spec §3, §50). Mixing them
 * is the single most damaging mistake this codebase can make, so each one gets a
 * branded type: `RestaurantId` cannot be passed where a `TerminalId` is expected,
 * even though both are strings at runtime.
 *
 *   RestaurantId       owns all operational data. Survives hardware changes.
 *   LicenseId          the commercial entitlement. Bound to exactly one restaurant.
 *   DeviceFingerprint  the *current* main PC. Never owns data.
 *   TerminalId         a physical/logical station (table, kitchen, cashier, ...).
 *   TableId            a table, which is also backed by a TABLE terminal.
 *   UserId             a human being, for accountability.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RestaurantId = Brand<string, 'RestaurantId'>;
export type LicenseId = Brand<string, 'LicenseId'>;
export type DeviceFingerprint = Brand<string, 'DeviceFingerprint'>;
export type TerminalId = Brand<string, 'TerminalId'>;
export type TableId = Brand<string, 'TableId'>;
export type UserId = Brand<string, 'UserId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type EntityId = Brand<string, 'EntityId'>;

export const RESTAURANT_ID_PATTERN = /^REST-\d{6}$/;
export const LICENSE_ID_PATTERN = /^LIC-\d{4}-\d{6}$/;
export const TERMINAL_ID_PATTERN = /^TERM-[0-9A-HJKMNP-TV-Z]{10}$/;
export const TABLE_ID_PATTERN = /^TABLE-[0-9A-Za-z_-]{1,24}$/;
export const USER_ID_PATTERN = /^USR-[0-9A-HJKMNP-TV-Z]{10}$/;
export const ORDER_ID_PATTERN = /^ORD-[0-9A-HJKMNP-TV-Z]{16}$/;
export const DEVICE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Crockford base32 alphabet: no I, L, O or U, so codes survive being read aloud. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(n: number): Uint8Array {
  // Node and browsers both expose WebCrypto; this package must stay runtime-neutral
  // because the same validation code runs in the browser terminals.
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Random Crockford-base32 string of `length` characters. */
export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CROCKFORD[bytes[i]! % 32];
  return out;
}

/**
 * Monotonic, lexicographically sortable id: 10 chars of timestamp (ms since
 * epoch, base32) + N chars of randomness. Sorting by id sorts by creation time,
 * which keeps SQLite indexes on primary keys cache-friendly.
 */
export function monotonicCode(randomLength: number, now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  return time + randomCode(randomLength);
}

export function newTerminalId(): TerminalId {
  return `TERM-${randomCode(10)}` as TerminalId;
}

export function newUserId(): UserId {
  return `USR-${randomCode(10)}` as UserId;
}

export function newOrderId(now?: number): OrderId {
  return `ORD-${monotonicCode(6, now)}` as OrderId;
}

/** Generic sortable id for rows that need no human-facing prefix. */
export function newEntityId(prefix: string, now?: number): EntityId {
  return `${prefix}-${monotonicCode(6, now)}` as EntityId;
}

/**
 * Restaurant ids are allocated by the license server so they are globally unique
 * across every installation the vendor ever sells. `sequence` is the vendor-side
 * counter; the id is stable for the life of the restaurant.
 */
export function formatRestaurantId(sequence: number): RestaurantId {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999_999) {
    throw new RangeError(`restaurant sequence out of range: ${sequence}`);
  }
  return `REST-${String(sequence).padStart(6, '0')}` as RestaurantId;
}

export function formatLicenseId(year: number, sequence: number): LicenseId {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError(`license year out of range: ${year}`);
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999_999) {
    throw new RangeError(`license sequence out of range: ${sequence}`);
  }
  return `LIC-${year}-${String(sequence).padStart(6, '0')}` as LicenseId;
}

/**
 * Table ids embed the operator-visible table number so the printed QR stays
 * readable by a human ("TABLE-05"). They are scoped by restaurant, never global.
 */
export function formatTableId(label: string): TableId {
  const normalised = label.trim().toUpperCase().replace(/[^0-9A-Z_-]+/g, '-');
  if (normalised.length === 0 || normalised.length > 24) {
    throw new RangeError(`table label cannot be turned into an id: "${label}"`);
  }
  return `TABLE-${normalised}` as TableId;
}

export const isRestaurantId = (v: unknown): v is RestaurantId =>
  typeof v === 'string' && RESTAURANT_ID_PATTERN.test(v);
export const isLicenseId = (v: unknown): v is LicenseId =>
  typeof v === 'string' && LICENSE_ID_PATTERN.test(v);
export const isTerminalId = (v: unknown): v is TerminalId =>
  typeof v === 'string' && TERMINAL_ID_PATTERN.test(v);
export const isTableId = (v: unknown): v is TableId =>
  typeof v === 'string' && TABLE_ID_PATTERN.test(v);
export const isUserId = (v: unknown): v is UserId =>
  typeof v === 'string' && USER_ID_PATTERN.test(v);
export const isOrderId = (v: unknown): v is OrderId =>
  typeof v === 'string' && ORDER_ID_PATTERN.test(v);
export const isDeviceFingerprint = (v: unknown): v is DeviceFingerprint =>
  typeof v === 'string' && DEVICE_FINGERPRINT_PATTERN.test(v);
