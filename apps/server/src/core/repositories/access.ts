/**
 * Users, roles, grants and sessions.
 *
 * Permissions are rows, not constants: `DEFAULT_ROLE_PERMISSIONS` seeds the
 * table once at install and is never consulted again, so a restaurant that
 * re-scopes its CASHIER role gets exactly what it configured.
 */

import type { Db } from '@qserve/db';
import { fromDbJson, nowIso, toDbJson } from '@qserve/db';
import { hashSecret, hashToken, newToken, verifySecret } from '@qserve/crypto';
import { newEntityId, newUserId, type Localised } from '@qserve/shared';

export interface RoleRow {
  id: string;
  key: string;
  name_json: string;
  is_system: number;
  created_at: string;
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  secret_hash: string;
  active: number;
  created_at: string;
  last_login_at: string | null;
}

export interface UserSessionRow {
  token_hash: string;
  user_id: string;
  terminal_id: string | null;
  created_at: string;
  expires_at: string;
  client_ip: string | null;
}

export class AccessRepository {
  constructor(private readonly db: Db) {}

  /* --------------------------------------------------------------- roles */

  listRoles(): { row: RoleRow; permissions: string[] }[] {
    const roles = this.db.prepare('SELECT * FROM roles ORDER BY key').all() as RoleRow[];
    return roles.map((row) => ({ row, permissions: this.permissionsForRole(row.id) }));
  }

  getRoleByKey(key: string): RoleRow | undefined {
    return this.db.prepare('SELECT * FROM roles WHERE key = ?').get(key) as RoleRow | undefined;
  }

  getRoleById(id: string): RoleRow | undefined {
    return this.db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow | undefined;
  }

  permissionsForRole(roleId: string): string[] {
    return (
      this.db
        .prepare('SELECT permission FROM role_permissions WHERE role_id = ?')
        .all(roleId) as { permission: string }[]
    ).map((r) => r.permission);
  }

  createRole(key: string, name: Localised, permissions: readonly string[]): RoleRow {
    const id = newEntityId('ROLE');
    this.db
      .prepare('INSERT INTO roles (id, key, name_json, is_system, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(id, key, toDbJson(name), nowIso());
    this.setRolePermissions(id, permissions);
    return this.getRoleById(id)!;
  }

  setRolePermissions(roleId: string, permissions: readonly string[]): void {
    const remove = this.db.prepare('DELETE FROM role_permissions WHERE role_id = ?');
    const add = this.db.prepare(
      'INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)',
    );
    this.db.transaction(() => {
      remove.run(roleId);
      for (const permission of permissions) add.run(roleId, permission);
    })();
  }

  deleteRole(roleId: string): void {
    this.db.prepare('DELETE FROM roles WHERE id = ? AND is_system = 0').run(roleId);
  }

  roleName(row: RoleRow): Localised {
    return fromDbJson<Localised>(row.name_json, {});
  }

  /* --------------------------------------------------------------- users */

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  listUsers(): { user: UserRow; roleKeys: string[] }[] {
    const users = this.db.prepare('SELECT * FROM users ORDER BY display_name').all() as UserRow[];
    return users.map((user) => ({ user, roleKeys: this.roleKeysForUser(user.id) }));
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  getUserByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | UserRow
      | undefined;
  }

  createUser(input: {
    username: string;
    displayName: string;
    secret: string;
    roleKeys: readonly string[];
  }): UserRow {
    const id = newUserId();
    this.db
      .prepare(`
        INSERT INTO users (id, username, display_name, secret_hash, active, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `)
      .run(id, input.username, input.displayName, hashSecret(input.secret), nowIso());
    this.setUserRoles(id, input.roleKeys);
    return this.getUser(id)!;
  }

  updateUser(id: string, patch: {
    displayName?: string;
    secret?: string;
    active?: boolean;
  }): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.displayName !== undefined) {
      assignments.push('display_name = ?');
      values.push(patch.displayName);
    }
    if (patch.secret !== undefined) {
      assignments.push('secret_hash = ?');
      values.push(hashSecret(patch.secret));
    }
    if (patch.active !== undefined) {
      assignments.push('active = ?');
      values.push(patch.active ? 1 : 0);
    }
    if (assignments.length === 0) return;
    this.db.prepare(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
  }

  deleteUser(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  setUserRoles(userId: string, roleKeys: readonly string[]): void {
    const remove = this.db.prepare('DELETE FROM user_roles WHERE user_id = ?');
    const add = this.db.prepare(
      'INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE key = ?',
    );
    this.db.transaction(() => {
      remove.run(userId);
      for (const key of roleKeys) add.run(userId, key);
    })();
  }

  roleKeysForUser(userId: string): string[] {
    return (
      this.db
        .prepare(`
          SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = ? ORDER BY r.key
        `)
        .all(userId) as { key: string }[]
    ).map((r) => r.key);
  }

  /** Union of the grants of every role the user holds. */
  permissionsForUser(userId: string): string[] {
    const rows = this.db
      .prepare(`
        SELECT DISTINCT rp.permission
        FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = ?
      `)
      .all(userId) as { permission: string }[];
    return rows.map((r) => r.permission);
  }

  verifyUserSecret(user: UserRow, secret: string): boolean {
    return verifySecret(secret, user.secret_hash);
  }

  touchLogin(userId: string): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), userId);
  }

  /* ------------------------------------------------------ user sessions */

  createUserSession(input: {
    userId: string;
    terminalId: string | null;
    ttlSeconds: number;
    clientIp: string | null;
  }): string {
    const token = newToken();
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    this.db
      .prepare(`
        INSERT INTO user_sessions (token_hash, user_id, terminal_id, created_at, expires_at, client_ip)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(hashToken(token), input.userId, input.terminalId, nowIso(), expiresAt, input.clientIp);
    return token;
  }

  getUserSession(token: string): UserSessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM user_sessions WHERE token_hash = ?')
      .get(hashToken(token)) as UserSessionRow | undefined;
  }

  deleteUserSession(token: string): void {
    this.db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  /** Sign a person out everywhere — used when an account is disabled. */
  deleteSessionsForUser(userId: string): void {
    this.db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  }

  purgeExpiredSessions(): void {
    const at = nowIso();
    this.db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(at);
    this.db.prepare('DELETE FROM terminal_sessions WHERE expires_at < ?').run(at);
  }
}
