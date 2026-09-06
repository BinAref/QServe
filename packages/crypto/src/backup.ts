/**
 * Encrypted backup container (spec §7).
 *
 * Layout — a single self-describing file:
 *
 *   magic      8 bytes   "QSRVBKP1"
 *   headerLen  4 bytes   big-endian uint32
 *   header     N bytes   canonical JSON, also used as AES-GCM associated data
 *   authTag    16 bytes
 *   ciphertext rest      AES-256-GCM over gzip(payload JSON)
 *
 * Because the header is authenticated as AAD, an attacker cannot edit the
 * restaurant id, the checksum or the KDF parameters without invalidating the
 * tag. Corruption and tampering are therefore both caught, and reported
 * distinctly from "wrong passphrase" so the operator knows what to do next.
 *
 * What a backup must never contain (spec §7) is enforced by the *caller*
 * assembling the payload; `assertNoVendorSecrets` below is the safety net.
 */

import {
  createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonicalJson } from './canonical-json.js';
import { sha256Hex } from './hash.js';
import { toBase64Url } from './encoding.js';

export const BACKUP_MAGIC = Buffer.from('QSRVBKP1', 'ascii');
export const BACKUP_FORMAT_VERSION = 1;

const KDF = { N: 1 << 15, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 } as const;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;

export interface BackupHeader {
  readonly v: number;
  readonly restaurantId: string;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly cipher: 'aes-256-gcm';
  readonly kdf: 'scrypt';
  readonly kdfN: number;
  readonly kdfR: number;
  readonly kdfP: number;
  readonly salt: string;
  readonly iv: string;
  readonly compression: 'gzip';
  /** SHA-256 of the uncompressed payload JSON. Integrity beyond the GCM tag. */
  readonly payloadSha256: string;
  readonly note: string | null;
}

export interface CreateBackupInput {
  readonly restaurantId: string;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly passphrase: string;
  readonly payload: unknown;
  readonly note?: string | null;
  readonly createdAt?: Date;
}

export const BackupErrorCode = {
  BAD_MAGIC: 'BACKUP_BAD_MAGIC',
  TRUNCATED: 'BACKUP_TRUNCATED',
  BAD_HEADER: 'BACKUP_BAD_HEADER',
  UNSUPPORTED_VERSION: 'BACKUP_UNSUPPORTED_VERSION',
  /** Wrong passphrase, or the file was modified after it was written. */
  AUTH_FAILED: 'BACKUP_AUTH_FAILED',
  CORRUPT_PAYLOAD: 'BACKUP_CORRUPT_PAYLOAD',
  CHECKSUM_MISMATCH: 'BACKUP_CHECKSUM_MISMATCH',
  VENDOR_SECRET_PRESENT: 'BACKUP_VENDOR_SECRET_PRESENT',
} as const;
export type BackupErrorCode = (typeof BackupErrorCode)[keyof typeof BackupErrorCode];

export class BackupError extends Error {
  constructor(readonly code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * Keys that must never appear anywhere in a backup payload (spec §7). Checked
 * recursively before writing and after reading, because a backup is the one
 * artefact a restaurant will happily email to a stranger for support.
 */
const FORBIDDEN_KEY_PATTERN =
  /(privateKey|private_key|signingKey|signing_key|vendorSecret|vendor_secret|masterKey|master_key|developerSecret|developer_secret|licenseServerSecret)/i;

export function assertNoVendorSecrets(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoVendorSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, member] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new BackupError(
        BackupErrorCode.VENDOR_SECRET_PRESENT,
        `refusing to write a backup containing "${key}" at ${path}`,
      );
    }
    assertNoVendorSecrets(member, `${path}.${key}`);
  }
}

const deriveKey = (passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer =>
  scryptSync(passphrase.normalize('NFKC'), salt, KDF.keyLength, {
    N: n, r, p, maxmem: KDF.maxmem,
  });

export function createBackup(input: CreateBackupInput): Buffer {
  if (input.passphrase.length < 8) {
    throw new BackupError(
      BackupErrorCode.BAD_HEADER,
      'backup passphrase must be at least 8 characters',
    );
  }
  assertNoVendorSecrets(input.payload);

  const payloadJson = canonicalJson(input.payload);
  const compressed = gzipSync(Buffer.from(payloadJson, 'utf8'), { level: 9 });

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(input.passphrase, salt, KDF.N, KDF.r, KDF.p);

  const header: BackupHeader = {
    v: BACKUP_FORMAT_VERSION,
    restaurantId: input.restaurantId,
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfN: KDF.N,
    kdfR: KDF.r,
    kdfP: KDF.p,
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    compression: 'gzip',
    payloadSha256: sha256Hex(payloadJson),
    note: input.note ?? null,
  };

  const headerBytes = Buffer.from(canonicalJson(header), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(headerBytes);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerBytes.length, 0);

  return Buffer.concat([BACKUP_MAGIC, headerLength, headerBytes, tag, ciphertext]);
}

export interface ReadBackupResult<T = unknown> {
  readonly header: BackupHeader;
  readonly payload: T;
}

/** Parse the header without needing the passphrase — used to list backups. */
export function readBackupHeader(file: Buffer): BackupHeader {
  if (file.length < BACKUP_MAGIC.length + 4) {
    throw new BackupError(BackupErrorCode.TRUNCATED, 'file is too small to be a backup');
  }
  const magic = file.subarray(0, BACKUP_MAGIC.length);
  if (!timingSafeEqual(magic, BACKUP_MAGIC)) {
    throw new BackupError(BackupErrorCode.BAD_MAGIC, 'not a QServe backup file');
  }

  const headerLength = file.readUInt32BE(BACKUP_MAGIC.length);
  const headerStart = BACKUP_MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerLength === 0 || headerLength > 1_000_000 || file.length < headerEnd + TAG_LENGTH) {
    throw new BackupError(BackupErrorCode.TRUNCATED, 'backup header is truncated');
  }

  let header: BackupHeader;
  try {
    header = JSON.parse(file.subarray(headerStart, headerEnd).toString('utf8')) as BackupHeader;
  } catch {
    throw new BackupError(BackupErrorCode.BAD_HEADER, 'backup header is not valid JSON');
  }
  if (header.v !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      BackupErrorCode.UNSUPPORTED_VERSION,
      `backup format v${header.v} is not supported by this version`,
    );
  }
  return header;
}

export function readBackup<T = unknown>(file: Buffer, passphrase: string): ReadBackupResult<T> {
  const header = readBackupHeader(file);

  const headerLength = file.readUInt32BE(BACKUP_MAGIC.length);
  const headerStart = BACKUP_MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  const headerBytes = file.subarray(headerStart, headerEnd);

  const tag = file.subarray(headerEnd, headerEnd + TAG_LENGTH);
  const ciphertext = file.subarray(headerEnd + TAG_LENGTH);

  const key = deriveKey(
    passphrase,
    Buffer.from(header.salt, 'base64url'),
    header.kdfN, header.kdfR, header.kdfP,
  );

  let compressed: Buffer;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm', key, Buffer.from(header.iv, 'base64url'),
    );
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(tag);
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM cannot distinguish a wrong key from a mutated file, and neither can we.
    throw new BackupError(
      BackupErrorCode.AUTH_FAILED,
      'backup could not be authenticated: wrong passphrase, or the file was altered',
    );
  }

  let payloadJson: string;
  try {
    payloadJson = gunzipSync(compressed).toString('utf8');
  } catch {
    throw new BackupError(BackupErrorCode.CORRUPT_PAYLOAD, 'backup payload could not be decompressed');
  }

  if (sha256Hex(payloadJson) !== header.payloadSha256) {
    throw new BackupError(
      BackupErrorCode.CHECKSUM_MISMATCH,
      'backup payload checksum does not match its header',
    );
  }

  let payload: T;
  try {
    payload = JSON.parse(payloadJson) as T;
  } catch {
    throw new BackupError(BackupErrorCode.CORRUPT_PAYLOAD, 'backup payload is not valid JSON');
  }

  assertNoVendorSecrets(payload);
  return { header, payload };
}
