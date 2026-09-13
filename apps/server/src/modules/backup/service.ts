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
 * What a backup carries, and there are two answers.
 *
 * **The menu alone.** A restaurant can take this before it has a licence,
 * because building the menu is what it does first and losing that work to a
 * reinstall would be the worst hour of its week. It is also what an owner
 * hands to a second branch.
 *
 * **Everything.** Available once the installation has been activated, because
 * "everything" only starts to mean something after there are tables, staff and
 * takings — and it stays available afterwards even if the licence is later
 * cancelled, since that is exactly when somebody needs their data out.
 *
 * Restoring the menu alone is safe against order history on purpose: an order
 * item captures its name and price at the time and holds no foreign key to a
 * product (see `schema.ts`), so replacing every product leaves last month's
 * receipts reading exactly as they did.
 */
export const BackupScope = { MENU: 'menu', FULL: 'full' } as const;
export type BackupScope = (typeof BackupScope)[keyof typeof BackupScope];

/** The menu, the things it is priced and drawn with, and its photographs. */
const MENU_TABLES: readonly string[] = [
  'restaurant',
  'currencies',
  'categories',
  'products',
  'product_options',
  'option_choices',
  'addons',
  'product_addons',
  'assets',
  'custom_locales',
  'custom_themes',
];

/**
 * Everything the restaurant owns, in dependency order so a restore can insert
 * it back without disabling foreign keys.
 *
 * `user_sessions` and `terminal_sessions` are deliberately absent: a restore
 * must not resurrect a signed-in tablet.
 */
const BACKED_UP_TABLES: readonly string[] = [
  'restaurant',
  'settings',
  'counters',
  'currencies',
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

/**
 * What a person can choose to bring in, and what they cannot choose apart.
 *
 * Importing is not all-or-nothing: somebody moving to a new computer wants
 * everything, and somebody borrowing a menu from their other branch wants the
 * dishes and not that branch's staff. So the confirmation offers the contents
 * as a list of things to tick.
 *
 * The groups are not free choices of table, because the tables are not
 * independent. An order names the table it was served at, the person who took
 * it and the terminal it came from; importing last year's orders without the
 * staff who took them produces rows pointing at people who do not exist, and
 * SQLite rejects the whole restore at COMMIT with a message about a foreign
 * key that means nothing to a restaurant owner.
 *
 * So each group carries every table that must move together, and names what it
 * cannot arrive without. The console ticks the prerequisites for you; the
 * server checks anyway, because the console is not the only thing that can
 * call it.
 */
export interface ImportGroup {
  readonly tables: readonly string[];
  readonly requires: readonly string[];
}

export const IMPORT_GROUPS: Readonly<Record<string, ImportGroup>> = {
  /** The dishes themselves, and everything priced or chosen with them. */
  menu: {
    tables: ['categories', 'products', 'product_options', 'option_choices',
      'addons', 'product_addons'],
    requires: [],
  },
  /*
   * Photographs stand alone: a dish holds its image id as plain text with no
   * foreign key, so a menu imported without its pictures loses the pictures
   * and nothing else. That is a real choice somebody might make — a menu file
   * with sixty photographs is large, and the other branch may want its own.
   */
  images: { tables: ['assets'], requires: [] },
  profile: { tables: ['restaurant'], requires: [] },
  currencies: { tables: ['currencies'], requires: [] },
  languages: { tables: ['custom_locales'], requires: [] },
  themes: { tables: ['custom_themes'], requires: [] },
  settings: { tables: ['settings', 'counters'], requires: [] },
  people: { tables: ['roles', 'role_permissions', 'users', 'user_roles'], requires: [] },
  terminals: { tables: ['terminals'], requires: [] },
  tables: { tables: ['dining_tables'], requires: ['terminals'] },
  orders: {
    tables: ['orders', 'order_items', 'order_item_selections', 'order_item_addons', 'payments'],
    requires: ['tables', 'terminals', 'people'],
  },
  printing: { tables: ['printers', 'print_jobs'], requires: ['orders'] },
  log: { tables: ['audit_log'], requires: [] },
};

/** Insert order matters: a product cannot land before its category. */
const GROUP_ORDER: readonly string[] = [
  'profile', 'settings', 'currencies', 'people', 'terminals', 'tables',
  'menu', 'images', 'orders', 'printing', 'languages', 'themes', 'log',
];

const tablesFor = (scope: BackupScope): readonly string[] =>
  (scope === BackupScope.MENU ? MENU_TABLES : BACKED_UP_TABLES);

/**
 * The groups this file actually contains, in the order they must be written.
 *
 * A menu backup has no `orders` group at all, so it is never offered — the
 * list a person is shown is the list of what is really in the file, not a
 * catalogue with most of it greyed out.
 */
function groupsIn(payload: BackupPayload): string[] {
  const scopeTables = new Set(tablesFor(payload.scope ?? BackupScope.FULL));
  return GROUP_ORDER.filter((name) => {
    const group = IMPORT_GROUPS[name]!;
    return group.tables.some((table) => scopeTables.has(table));
  });
}

/** Every prerequisite of everything chosen, which is what "some" has to mean. */
function withRequirements(chosen: readonly string[]): string[] {
  const wanted = new Set(chosen);
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of [...wanted]) {
      for (const needed of IMPORT_GROUPS[name]?.requires ?? []) {
        if (!wanted.has(needed)) { wanted.add(needed); grew = true; }
      }
    }
  }
  return GROUP_ORDER.filter((name) => wanted.has(name));
}

/** Cleared before a restore, in reverse dependency order. */
const clearOrderFor = (scope: BackupScope): readonly string[] => [...tablesFor(scope)].reverse();

interface BackupPayload {
  readonly kind: 'qserve.restaurant.backup';
  readonly restaurantId: string;
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly createdAt: string;
  /** Absent in files written before scopes existed; those are full backups. */
  readonly scope?: BackupScope;
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
    scope?: BackupScope;
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

    const scope = input.scope ?? BackupScope.FULL;
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of tablesFor(scope)) {
      tables[table] = this.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    }

    const payload: BackupPayload = {
      kind: 'qserve.restaurant.backup',
      restaurantId: profile.restaurantId,
      schemaVersion: RESTAURANT_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: nowIso(),
      scope,
      tables,
      // Both scopes carry the photographs: a menu without them is not a menu.
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
    // The scope is in the name so a folder of these can be told apart at a
    // glance, months later, by somebody looking for "the menu one".
    const fileName = `${profile.restaurantId}-${scope}-${stamp}.qsbk`;
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
      detail: { byteSize: file.length, note: input.note, scope },
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
    /** What to bring in. Omitted means everything the file holds. */
    groups?: readonly string[];
    actor: Actor;
    clientIp: string | null;
  }): Promise<{ restaurantId: string; tables: number; rows: number; groups: string[] }> {
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

    const scope = payload.scope ?? BackupScope.FULL;
    const available = groupsIn(payload);

    /*
     * What was asked for, plus whatever it cannot arrive without. Choosing the
     * orders and not the staff who took them would produce rows pointing at
     * people who do not exist, and SQLite would reject the whole restore with
     * a message about a foreign key that means nothing to a restaurant owner.
     */
    const asked = input.groups && input.groups.length > 0 ? input.groups : available;
    for (const name of asked) {
      if (!IMPORT_GROUPS[name]) {
        throw validationError(`there is nothing called "${name}" in a backup`, { field: 'groups' });
      }
      if (!available.includes(name)) {
        throw conflict(`this file does not contain ${name}`, { available });
      }
    }
    const chosen = withRequirements(asked).filter((name) => available.includes(name));
    const chosenTables = new Set(chosen.flatMap((name) => IMPORT_GROUPS[name]!.tables));

    let rowCount = 0;
    const restore = this.db.transaction(() => {
      // Foreign keys are suspended only for the swap. `defer_foreign_keys`
      // re-checks every constraint at COMMIT, so a backup with dangling
      // references is rejected rather than silently imported.
      this.db.pragma('defer_foreign_keys = ON');

      /*
       * Only what was chosen. A menu file replaces the menu and leaves the
       * tables, the staff and the takings where they are; a person who ticked
       * three of nine boxes keeps the other six exactly as they were. Clearing
       * everything and calling it a restore is the kind of helpfulness nobody
       * recovers from.
       */
      for (const table of clearOrderFor(scope)) {
        if (!chosenTables.has(table)) continue;
        this.db.prepare(`DELETE FROM ${table}`).run();
      }

      for (const table of tablesFor(scope)) {
        if (!chosenTables.has(table)) continue;
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
      tables: chosenTables.size,
      rows: rowCount,
      groups: chosen,
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

  /**
   * Read a backup and say what is in it, without touching anything.
   *
   * Restoring replaces what is here, and "are you sure" is a question nobody
   * can answer without knowing what they are agreeing to. So the file is opened
   * first and counted, and the person is shown the actual contents — 3
   * categories, 24 dishes, 61 photographs — before the button that does it.
   *
   * Decrypting twice, once here and once to apply, is the cost. A backup is a
   * few megabytes and this happens when somebody presses a button, so the cost
   * is nothing and the alternative is holding a decrypted copy of a
   * restaurant's entire database in memory between two requests.
   */
  async preview(file: Buffer, passphrase: string): Promise<{
    scope: BackupScope;
    restaurantId: string;
    createdAt: string;
    appVersion: string;
    note: string | null;
    counts: Record<string, number>;
    replaces: Record<string, number>;
    groups: { name: string; rows: number; requires: readonly string[] }[];
  }> {
    let payload: BackupPayload;
    let note: string | null = null;
    try {
      const opened = readBackup<BackupPayload>(file, passphrase);
      payload = opened.payload;
      note = (opened as { note?: string | null }).note ?? null;
    } catch (error) {
      if (error instanceof BackupError) throw conflict(error.message, { code: error.code });
      throw error;
    }

    if (payload.kind !== 'qserve.restaurant.backup') {
      throw conflict('this file is not a QServe restaurant backup');
    }

    const scope = payload.scope ?? BackupScope.FULL;
    const count = (table: string) => (payload.tables[table] ?? []).length;

    /*
     * Counted in the words a restaurant uses, not in table names. "products:
     * 24" is a schema; "24 dishes" is a menu. Only the rows worth mentioning
     * appear — nobody needs to be told how many role_permissions there are.
     */
    const named: Record<string, number> = {
      categories: count('categories'),
      products: count('products'),
      options: count('product_options') + count('addons'),
      images: Object.keys(payload.assets ?? {}).length,
      languages: count('custom_locales'),
      themes: count('custom_themes'),
    };
    if (scope === BackupScope.FULL) {
      named['tables'] = count('dining_tables');
      named['terminals'] = count('terminals');
      named['people'] = count('users');
      named['orders'] = count('orders');
      named['payments'] = count('payments');
    }

    // And what would go. Being told what arrives without being told what leaves
    // is half an answer.
    const replaces: Record<string, number> = {};
    for (const [name, table] of Object.entries({
      categories: 'categories', products: 'products', images: 'assets',
      ...(scope === BackupScope.FULL
        ? { tables: 'dining_tables', people: 'users', orders: 'orders' }
        : {}),
    })) {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      replaces[name] = row.n;
    }

    /*
     * The tick list. Only groups this file actually holds, and only ones with
     * something in them — a checkbox next to "0 orders" is a decision nobody
     * needs to make.
     */
    const groups = groupsIn(payload)
      .map((name) => ({
        name,
        rows: name === 'images'
          ? Object.keys(payload.assets ?? {}).length
          : IMPORT_GROUPS[name]!.tables.reduce((total, table) => total + count(table), 0),
        requires: IMPORT_GROUPS[name]!.requires,
      }))
      .filter((group) => group.rows > 0);

    return {
      scope,
      restaurantId: payload.restaurantId,
      createdAt: payload.createdAt,
      appVersion: payload.appVersion,
      note,
      counts: Object.fromEntries(Object.entries(named).filter(([, n]) => n > 0)),
      replaces: Object.fromEntries(Object.entries(replaces).filter(([, n]) => n > 0)),
      groups,
    };
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
