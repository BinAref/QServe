/**
 * SQLite connection setup.
 *
 * SQLite is the right database for this product: the operational store lives on
 * one restaurant PC, must survive that PC losing power mid-service, and must
 * never need a DBA. WAL mode gives concurrent readers (the kitchen screen, the
 * cashier, a dozen diners' phones) while a write is in flight, and
 * `synchronous = FULL` trades a little throughput for durability — a restaurant
 * losing the last order to a power cut is not acceptable.
 */

import Database, { type Database as Db } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type { Db };

export interface OpenOptions {
  /** `:memory:` is used by the test suite. */
  readonly file: string;
  readonly readOnly?: boolean;
  /**
   * FULL is the default. NORMAL is measurably faster and still crash-safe in
   * WAL mode; it is offered for installations on slow USB storage.
   */
  readonly synchronous?: 'FULL' | 'NORMAL';
}

export function openDatabase(options: OpenOptions): Db {
  if (options.file !== ':memory:') {
    mkdirSync(dirname(options.file), { recursive: true });
  }

  const db = new Database(options.file, { readonly: options.readOnly ?? false });

  db.pragma('journal_mode = WAL');
  db.pragma(`synchronous = ${options.synchronous ?? 'FULL'}`);
  db.pragma('foreign_keys = ON');
  // Wait rather than fail when the writer holds the lock; a busy service can
  // briefly queue behind a backup or a report.
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');

  return db;
}

/**
 * Run `fn` inside an IMMEDIATE transaction. IMMEDIATE (rather than DEFERRED)
 * takes the write lock up front, which turns a mid-transaction lock conflict
 * into an immediate, retryable failure instead of a surprise rollback.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}
