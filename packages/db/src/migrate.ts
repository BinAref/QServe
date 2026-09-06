/**
 * Forward-only migration runner.
 *
 * Restaurants upgrade the app by replacing a folder; there is nobody on site to
 * run a migration tool. So migrations apply automatically at boot, inside a
 * transaction, and the schema version is recorded in the database itself. A
 * failed migration rolls back and refuses to start rather than leaving a
 * half-migrated store serving orders.
 */

import type { Db } from './open.js';

export interface Migration {
  /** Strictly increasing. Gaps are allowed; duplicates are a programming error. */
  readonly version: number;
  readonly name: string;
  readonly up: (db: Db) => void;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

const SCHEMA_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL
  )
`;

export function currentSchemaVersion(db: Db): number {
  db.exec(SCHEMA_TABLE);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

export function runMigrations(db: Db, migrations: readonly Migration[]): MigrationResult {
  db.exec(SCHEMA_TABLE);

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.version === ordered[i - 1]!.version) {
      throw new Error(`duplicate migration version ${ordered[i]!.version}`);
    }
  }

  const from = currentSchemaVersion(db);
  const pending = ordered.filter((m) => m.version > from);
  const applied: string[] = [];

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of pending) {
    // Each migration is its own transaction: an upgrade that fails at step 7
    // keeps steps 1-6, and the next boot resumes from there.
    const apply = db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    try {
      apply.immediate();
    } catch (error) {
      throw new Error(
        `migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    applied.push(`${migration.version}:${migration.name}`);
  }

  return { from, to: currentSchemaVersion(db), applied };
}
