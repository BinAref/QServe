/**
 * Data access for the license server. All SQL lives here; `service.ts` holds
 * the rules and never writes a query.
 */

import type { Db } from '@qserve/db';
import { nowIso, transaction } from '@qserve/db';
import {
  formatLicenseId, formatRestaurantId, monotonicCode,
  type LicenseStatus, type LicenseType,
} from '@qserve/shared';

export interface RestaurantRow {
  restaurant_id: string;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  country: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface LicenseRow {
  license_id: string;
  restaurant_id: string;
  key_hash: string;
  key_hint: string;
  license_type: LicenseType;
  status: LicenseStatus;
  transfer_credits: number;
  transfer_count: number;
  activated_at: string | null;
  app_version: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivationRow {
  id: string;
  license_id: string;
  device_fingerprint: string;
  device_label: string | null;
  app_version: string | null;
  activated_at: string;
  released_at: string | null;
  release_reason: string | null;
  client_ip: string | null;
}

export interface TransferRow {
  id: string;
  license_id: string;
  from_fingerprint: string | null;
  to_fingerprint: string | null;
  reason: string | null;
  fee_reference: string | null;
  performed_by: string;
  created_at: string;
}

export interface AdminUserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  active: number;
  created_at: string;
  last_login_at: string | null;
}

export class LicenseStore {
  constructor(private readonly db: Db) {}

  /* ------------------------------------------------------------ counters */

  /**
   * Allocate the next id in a sequence. Runs inside the caller's transaction so
   * two concurrent issuances cannot receive the same number.
   */
  private nextSequence(name: string): number {
    this.db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
    const row = this.db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as
      | { value: number }
      | undefined;
    if (!row) throw new Error(`unknown counter: ${name}`);
    return row.value;
  }

  /* --------------------------------------------------------- restaurants */

  createRestaurant(input: {
    name: string;
    contactName?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
    country?: string | null;
    notes?: string | null;
  }): RestaurantRow {
    const at = nowIso();
    const restaurantId = formatRestaurantId(this.nextSequence('restaurant'));
    this.db
      .prepare(`
        INSERT INTO restaurants
          (restaurant_id, name, contact_name, contact_phone, contact_email, country, notes,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        restaurantId, input.name, input.contactName ?? null, input.contactPhone ?? null,
        input.contactEmail ?? null, input.country ?? null, input.notes ?? null, at, at,
      );
    return this.getRestaurant(restaurantId)!;
  }

  getRestaurant(restaurantId: string): RestaurantRow | undefined {
    return this.db
      .prepare('SELECT * FROM restaurants WHERE restaurant_id = ?')
      .get(restaurantId) as RestaurantRow | undefined;
  }

  updateRestaurant(restaurantId: string, patch: Partial<Pick<RestaurantRow,
    'name' | 'contact_name' | 'contact_phone' | 'contact_email' | 'country' | 'notes'>>): void {
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    const assignments = fields.map((f) => `${f} = ?`).join(', ');
    this.db
      .prepare(`UPDATE restaurants SET ${assignments}, updated_at = ? WHERE restaurant_id = ?`)
      .run(...fields.map((f) => (patch as Record<string, unknown>)[f]), nowIso(), restaurantId);
  }

  searchRestaurants(query: string, limit = 50): RestaurantRow[] {
    const like = `%${query}%`;
    return this.db
      .prepare(`
        SELECT * FROM restaurants
        WHERE restaurant_id LIKE ? OR name LIKE ? OR contact_phone LIKE ? OR contact_email LIKE ?
        ORDER BY created_at DESC LIMIT ?
      `)
      .all(like, like, like, like, limit) as RestaurantRow[];
  }

  listRestaurants(limit = 100, offset = 0): RestaurantRow[] {
    return this.db
      .prepare('SELECT * FROM restaurants ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as RestaurantRow[];
  }

  /* ------------------------------------------------------------ licenses */

  createLicense(input: {
    restaurantId: string;
    keyHash: string;
    keyHint: string;
    licenseType: LicenseType;
    licenseYear: number;
    notes?: string | null;
  }): LicenseRow {
    const at = nowIso();
    const licenseId = formatLicenseId(input.licenseYear, this.nextSequence('license'));
    this.db
      .prepare(`
        INSERT INTO licenses
          (license_id, restaurant_id, key_hash, key_hint, license_type, status,
           transfer_credits, transfer_count, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'PENDING', 0, 0, ?, ?, ?)
      `)
      .run(licenseId, input.restaurantId, input.keyHash, input.keyHint,
           input.licenseType, input.notes ?? null, at, at);
    return this.getLicense(licenseId)!;
  }

  getLicense(licenseId: string): LicenseRow | undefined {
    return this.db.prepare('SELECT * FROM licenses WHERE license_id = ?').get(licenseId) as
      | LicenseRow
      | undefined;
  }

  getLicenseByKeyHash(keyHash: string): LicenseRow | undefined {
    return this.db.prepare('SELECT * FROM licenses WHERE key_hash = ?').get(keyHash) as
      | LicenseRow
      | undefined;
  }

  listLicensesForRestaurant(restaurantId: string): LicenseRow[] {
    return this.db
      .prepare('SELECT * FROM licenses WHERE restaurant_id = ? ORDER BY created_at DESC')
      .all(restaurantId) as LicenseRow[];
  }

  searchLicenses(query: string, limit = 50): LicenseRow[] {
    const like = `%${query}%`;
    return this.db
      .prepare(`
        SELECT l.* FROM licenses l
        JOIN restaurants r ON r.restaurant_id = l.restaurant_id
        WHERE l.license_id LIKE ? OR l.restaurant_id LIKE ? OR r.name LIKE ? OR l.key_hint LIKE ?
        ORDER BY l.created_at DESC LIMIT ?
      `)
      .all(like, like, like, like, limit) as LicenseRow[];
  }

  updateLicense(licenseId: string, patch: Partial<Pick<LicenseRow,
    'status' | 'transfer_credits' | 'transfer_count' | 'activated_at' | 'app_version' | 'notes'>>): void {
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    const assignments = fields.map((f) => `${f} = ?`).join(', ');
    this.db
      .prepare(`UPDATE licenses SET ${assignments}, updated_at = ? WHERE license_id = ?`)
      .run(...fields.map((f) => (patch as Record<string, unknown>)[f]), nowIso(), licenseId);
  }

  /* --------------------------------------------------------- activations */

  liveActivation(licenseId: string): ActivationRow | undefined {
    return this.db
      .prepare('SELECT * FROM activations WHERE license_id = ? AND released_at IS NULL')
      .get(licenseId) as ActivationRow | undefined;
  }

  activationHistory(licenseId: string): ActivationRow[] {
    return this.db
      .prepare('SELECT * FROM activations WHERE license_id = ? ORDER BY activated_at DESC')
      .all(licenseId) as ActivationRow[];
  }

  insertActivation(input: {
    licenseId: string;
    deviceFingerprint: string;
    deviceLabel: string | null;
    appVersion: string | null;
    clientIp: string | null;
  }): ActivationRow {
    const id = `ACT-${monotonicCode(8)}`;
    this.db
      .prepare(`
        INSERT INTO activations
          (id, license_id, device_fingerprint, device_label, app_version, activated_at, client_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, input.licenseId, input.deviceFingerprint, input.deviceLabel,
           input.appVersion, nowIso(), input.clientIp);
    return this.db.prepare('SELECT * FROM activations WHERE id = ?').get(id) as ActivationRow;
  }

  releaseActivation(activationId: string, reason: string): void {
    this.db
      .prepare('UPDATE activations SET released_at = ?, release_reason = ? WHERE id = ?')
      .run(nowIso(), reason, activationId);
  }

  /* ----------------------------------------------------------- transfers */

  insertTransfer(input: {
    licenseId: string;
    fromFingerprint: string | null;
    toFingerprint: string | null;
    reason: string | null;
    feeReference: string | null;
    performedBy: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO transfers
          (id, license_id, from_fingerprint, to_fingerprint, reason, fee_reference,
           performed_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(`TRF-${monotonicCode(8)}`, input.licenseId, input.fromFingerprint,
           input.toFingerprint, input.reason, input.feeReference, input.performedBy, nowIso());
  }

  transferHistory(licenseId: string): TransferRow[] {
    return this.db
      .prepare('SELECT * FROM transfers WHERE license_id = ? ORDER BY created_at DESC')
      .all(licenseId) as TransferRow[];
  }

  /* -------------------------------------------------------- signing keys */

  upsertSigningKey(keyId: string, publicKey: string): void {
    this.db
      .prepare(`
        INSERT INTO signing_keys (key_id, public_key, active, created_at) VALUES (?, ?, 1, ?)
        ON CONFLICT(key_id) DO UPDATE SET active = 1
      `)
      .run(keyId, publicKey, nowIso());
  }

  listSigningKeys(): { key_id: string; public_key: string; active: number; created_at: string }[] {
    return this.db.prepare('SELECT * FROM signing_keys ORDER BY created_at DESC').all() as {
      key_id: string; public_key: string; active: number; created_at: string;
    }[];
  }

  /* --------------------------------------------------------------- admin */

  countAdmins(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number };
    return row.n;
  }

  createAdmin(input: { username: string; passwordHash: string; displayName: string }): AdminUserRow {
    const id = `ADM-${monotonicCode(8)}`;
    this.db
      .prepare(`
        INSERT INTO admin_users (id, username, password_hash, display_name, active, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `)
      .run(id, input.username, input.passwordHash, input.displayName, nowIso());
    return this.db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id) as AdminUserRow;
  }

  getAdminByUsername(username: string): AdminUserRow | undefined {
    return this.db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username) as
      | AdminUserRow
      | undefined;
  }

  getAdminById(id: string): AdminUserRow | undefined {
    return this.db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id) as
      | AdminUserRow
      | undefined;
  }

  touchAdminLogin(id: string): void {
    this.db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(nowIso(), id);
  }

  createSession(tokenHash: string, adminId: string, expiresAt: string, ip: string | null): void {
    this.db
      .prepare(`
        INSERT INTO admin_sessions (token_hash, admin_id, created_at, expires_at, client_ip)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(tokenHash, adminId, nowIso(), expiresAt, ip);
  }

  getSession(tokenHash: string): { admin_id: string; expires_at: string } | undefined {
    return this.db
      .prepare('SELECT admin_id, expires_at FROM admin_sessions WHERE token_hash = ?')
      .get(tokenHash) as { admin_id: string; expires_at: string } | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
  }

  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(nowIso());
  }

  /* ----------------------------------------------------------- audit log */

  audit(entry: {
    actor: string;
    action: string;
    licenseId?: string | null;
    restaurantId?: string | null;
    detail?: Record<string, unknown>;
    clientIp?: string | null;
  }): void {
    this.db
      .prepare(`
        INSERT INTO audit_log (id, at, actor, action, license_id, restaurant_id, detail, client_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(`AUD-${monotonicCode(8)}`, nowIso(), entry.actor, entry.action,
           entry.licenseId ?? null, entry.restaurantId ?? null,
           JSON.stringify(entry.detail ?? {}), entry.clientIp ?? null);
  }

  recentAudit(limit = 100): unknown[] {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit);
  }

  /**
   * Projection for anything leaving the server. `key_hash` is the verifier for
   * a bearer secret, so it stays inside this process even on authenticated
   * console responses.
   */
  static publicView(license: LicenseRow): Omit<LicenseRow, 'key_hash'> {
    const { key_hash: _omitted, ...rest } = license;
    return rest;
  }

  /** Expose a transaction helper so the service can compose multi-table writes. */
  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }
}
