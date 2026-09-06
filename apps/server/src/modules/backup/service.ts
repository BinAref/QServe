/**
 * Backup and restore (spec §7).
 *
 * The promise this module makes: move to a new computer, restore, and the
 * restaurant carries on with the same menu, the same tables, the same printed
 * QR codes and the same order history. Nobody retypes a menu.
 *
 * What a backup contains is everything the *restaurant* owns. What it must
 * never contain is anything that belongs to the vendor or to a particular
 * machine:
 *
 *   excluded  vendor signing keys (never on this machine at all)
 *   excluded  the activation certificate (bound to the old device's fingerprint)
 *   excluded  the licence key and the install id (kept outside the database)
 *   excluded  live sessions (a restore must not resurrect a signed-in tablet)
 *
 * Staff password hashes *are* included: they are scrypt hashes, and losing them
 * would mean re-enrolling every employee after a hardware failure.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@qserve/db';
import { nowIso } from '@qserve/db';
import {
  APP_VERSION, conflict, newEntityId, notFound, validationError,
  type Actor, type BackupDescriptor,
} from '@qserve/shared';
import { createBackup, readBackup, readBackupHeader, BackupError } from '@qserve/crypto';
import type { AuditRepository } from '../../core/repositories/audit.js';
import type { SettingsRepository } from '../../core/repositories/settings.js';
import type { Paths } from '../../core/paths.js';
import { RESTAURANT_SCHEMA_VERSION } from '../../core/schema.js';

/**
 * Tables carried by a backup, in dependency order so a restore can insert them
 * back without disabling foreign keys.
 *
 * `user_sessions` and `terminal_sessions` are deliberately absent.
 */
const BACKED_UP_TABLES: readonly string[] = [
  'restaurant',
  'settings',
  'counters',
  'roles',
  'role_permissions',
  'users',
  'user_roles',
  'terminals',
  'dining_tables',
  'categories',
  'products',
  'product_options',
  'option_choices',
  'addons',
  'product_addons',
  'assets',
  'orders',
  'order_items',
  'order_item_selections',
  'order_item_addons',
  'payments',
  'printers',
  'print_jobs',
  'audit_log',
  'custom_locales',
  'custom_themes',
];

/** Cleared before a restore, in reverse dependency order. */
const RESTORE_CLEAR_ORDER: readonly string[] = [...BACKED_UP_TABLES].reverse();

interface BackupPayload {
  readonly kind: 'qserve.restaurant.backup';
  readonly restaurantId: string;
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly createdAt: string;
  readonly tables: Record<string, Record<string, unknown>[]>;
  /** Menu and logo images, base64-encoded and keyed by asset id. */
  readonly assets: Record<string, { fileName: string; contentType: string; base64: string }>;
}

export class BackupService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditRepository,
    private readonly paths: Paths,
  ) {}

  /* ------------------------------------------------------------- create */

  async create(input: {
    passphrase: string;
    note: string | null;
    actor: Actor;
    clientIp: string | null;
  }): Promise<BackupDescriptor> {
    const profile = this.settings.profile();
    if (!profile) throw conflict('there is no restaurant to back up yet');
    if (input.passphrase.length < 8) {
      throw validationError('the backup passphrase must be at least 8 characters', {
        field: 'passphrase',
      });
    }

    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of BACKED_UP_TABLES) {
      tables[table] = this.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    }

    const payload: BackupPayload = {
      kind: 'qserve.restaurant.backup',
      restaurantId: profile.restaurantId,
      schemaVersion: RESTAURANT_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: nowIso(),
      tables,
      assets: await this.collectAssets(),
    };

    const file = createBackup({
      restaurantId: profile.restaurantId,
      appVersion: APP_VERSION,
      schemaVersion: RESTAURANT_SCHEMA_VERSION,
      passphrase: input.passphrase,
      payload,
      note: input.note,
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${profile.restaurantId}-${stamp}.qsbk`;
    await writeFile(join(this.paths.backupsDir, fileName), file);

    const checksum = createHash('sha256').update(file).digest('hex');
    this.db
      .prepare(`
        INSERT INTO backups
          (id, file_name, byte_size, checksum, app_version, schema_version, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        newEntityId('BAK'), fileName, file.length, checksum,
        APP_VERSION, RESTAURANT_SCHEMA_VERSION, input.note, nowIso(),
      );

    this.audit.record({
      action: 'backup.created',
      actor: input.actor,
      entityType: 'backup',
      entityId: fileName,
      detail: { byteSize: file.length, note: input.note },
      clientIp: input.clientIp,
    });

    await this.pruneOldBackups();
    return this.describe(fileName, file.length, checksum, input.note);
  }

  private async collectAssets(): Promise<BackupPayload['assets']> {
    const rows = this.db.prepare('SELECT * FROM assets').all() as {
      id: string; file_name: string; content_type: string;
    }[];

    const assets: BackupPayload['assets'] = {};
    for (const row of rows) {
      try {
        const bytes = await readFile(join(this.paths.assetsDir, row.file_name));
        assets[row.id] = {
          fileName: row.file_name,
          contentType: row.content_type,
          base64: bytes.toString('base64'),
        };
      } catch {
        // A missing image should not abort a backup of the whole restaurant;
        // the rest of the data is far more valuable than one lost photo.
      }
    }
    return assets;
  }

  /* ------------------------------------------------------------ restore */

  /**
   * Replace the local data with a backup's contents.
   *
   * The whole restore is one transaction: either every table is replaced or
   * none is. A half-restored restaurant would be worse than no restore at all.
   */
  async restore(input: {
    file: Buffer;
    passphrase: string;
    actor: Actor;
    clientIp: string | null;
  }): Promise<{ restaurantId: string; tables: number; rows: number }> {
    let payload: BackupPayload;
    try {
      payload = readBackup<BackupPayload>(input.file, input.passphrase).payload;
    } catch (error) {
      if (error instanceof BackupError) {
        throw conflict(error.message, { code: error.code });
      }
      throw error;
    }

    if (payload.kind !== 'qserve.restaurant.backup') {
      throw conflict('this file is not a QServe restaurant backup');
    }
    if (payload.schemaVersion > RESTAURANT_SCHEMA_VERSION) {
      throw conflict(
        'this backup was written by a newer version of QServe; upgrade before restoring',
        { backupSchema: payload.schemaVersion, supported: RESTAURANT_SCHEMA_VERSION },
      );
    }

    let rowCount = 0;
    const restore = this.db.transaction(() => {
      // Foreign keys are suspended only for the swap. `defer_foreign_keys`
      // re-checks every constraint at COMMIT, so a backup with dangling
      // references is rejected rather than silently imported.
      this.db.pragma('defer_foreign_keys = ON');

      for (const table of RESTORE_CLEAR_ORDER) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }

      for (const table of BACKED_UP_TABLES) {
        const rows = payload.tables[table] ?? [];
        if (rows.length === 0) continue;

        const columns = Object.keys(rows[0]!);
        const statement = this.db.prepare(
          `INSERT INTO ${table} (${columns.join(', ')}) ` +
          `VALUES (${columns.map(() => '?').join(', ')})`,
        );
        for (const row of rows) {
          statement.run(...columns.map((column) => row[column] ?? null));
          rowCount += 1;
        }
      }
    });

    restore.immediate();
    await this.restoreAssets(payload.assets);

    this.audit.record({
      action: 'backup.restored',
      actor: input.actor,
      entityType: 'backup',
      detail: {
        restaurantId: payload.restaurantId,
        createdAt: payload.createdAt,
        appVersion: payload.appVersion,
        rows: rowCount,
      },
      clientIp: input.clientIp,
    });

    return {
      restaurantId: payload.restaurantId,
      tables: BACKED_UP_TABLES.length,
      rows: rowCount,
    };
  }

  private async restoreAssets(assets: BackupPayload['assets']): Promise<void> {
    for (const asset of Object.values(assets)) {
      await writeFile(
        join(this.paths.assetsDir, asset.fileName),
        Buffer.from(asset.base64, 'base64'),
      );
    }
  }

  /* ------------------------------------------------------------ listing */

  async list(): Promise<BackupDescriptor[]> {
    const rows = this.db
      .prepare('SELECT * FROM backups ORDER BY created_at DESC')
      .all() as {
        id: string; file_name: string; byte_size: number; checksum: string;
        app_version: string; schema_version: number; note: string | null; created_at: string;
      }[];

    const profile = this.settings.profile();
    return rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      sizeBytes: row.byte_size,
      restaurantId: profile?.restaurantId ?? '',
      appVersion: row.app_version,
      createdAt: row.created_at,
      checksum: row.checksum,
      encrypted: true,
      note: row.note,
    }));
  }

  async read(fileName: string): Promise<Buffer> {
    if (!/^[A-Za-z0-9._-]+\.qsbk$/.test(fileName)) {
      throw validationError('invalid backup file name', { field: 'fileName' });
    }
    try {
      return await readFile(join(this.paths.backupsDir, fileName));
    } catch {
      throw notFound('backup', fileName);
    }
  }

  /**
   * Header-only inspection: tells the operator which restaurant and which date
   * a file holds *before* they type a passphrase or overwrite anything.
   */
  async inspect(file: Buffer): Promise<Record<string, unknown>> {
    try {
      const header = readBackupHeader(file);
      return {
        restaurantId: header.restaurantId,
        appVersion: header.appVersion,
        schemaVersion: header.schemaVersion,
        createdAt: header.createdAt,
        note: header.note,
        encrypted: true,
        sizeBytes: file.length,
      };
    } catch (error) {
      if (error instanceof BackupError) throw conflict(error.message, { code: error.code });
      throw error;
    }
  }

  /** Keep the newest `backup.keepCount` files; delete the rest from disk. */
  private async pruneOldBackups(): Promise<void> {
    const keep = this.settings.get<number>('backup.keepCount');
    if (!Number.isInteger(keep) || keep <= 0) return;

    const files = await readdir(this.paths.backupsDir).catch(() => [] as string[]);
    const backups = files.filter((name) => name.endsWith('.qsbk'));
    if (backups.length <= keep) return;

    const withTimes = await Promise.all(
      backups.map(async (name) => ({
        name,
        mtime: (await stat(join(this.paths.backupsDir, name))).mtimeMs,
      })),
    );
    withTimes.sort((a, b) => b.mtime - a.mtime);

    for (const stale of withTimes.slice(keep)) {
      await unlink(join(this.paths.backupsDir, stale.name)).catch(() => {});
      this.db.prepare('DELETE FROM backups WHERE file_name = ?').run(stale.name);
    }
  }

  private describe(
    fileName: string, size: number, checksum: string, note: string | null,
  ): BackupDescriptor {
    return {
      id: fileName,
      fileName,
      sizeBytes: size,
      restaurantId: this.settings.profile()?.restaurantId ?? '',
      appVersion: APP_VERSION,
      createdAt: nowIso(),
      checksum,
      encrypted: true,
      note,
    };
  }

  /** Tables a backup carries. Exposed so the docs and tests stay in step. */
  static get backedUpTables(): readonly string[] {
    return BACKED_UP_TABLES;
  }
}
