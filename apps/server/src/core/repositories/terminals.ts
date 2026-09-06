/**
 * Terminals (spec §24) — the single abstraction behind every screen in the
 * restaurant: a table's QR card, a waiter's phone, a cashier station, a kitchen
 * display, a bar screen, a printer bridge.
 *
 * Because tables are terminals too, adding a new station type later needs no
 * new session mechanism, no new QR pipeline and no new permission plumbing.
 */

import type { Db } from '@qserve/db';
import { fromDbJson, fromDbStringList, nowIso, toDbJson } from '@qserve/db';
import { constantTimeEquals, hashToken, newToken } from '@qserve/crypto';
import {
  defaultSoundProfile, newTerminalId, randomCode, TerminalStatus,
  type Localised, type SoundProfile, type TerminalType,
} from '@qserve/shared';

export interface TerminalRow {
  id: string;
  terminal_type: TerminalType;
  name_json: string;
  status: string;
  permissions_json: string;
  config_json: string;
  sound_profile_json: string;
  enrol_token: string;
  public_code: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TerminalSessionRow {
  token_hash: string;
  terminal_id: string;
  created_at: string;
  expires_at: string;
  client_ip: string | null;
  user_agent: string | null;
}

export interface CreatedTerminal {
  readonly row: TerminalRow;
  /** The enrolment secret to encode into the QR image. */
  readonly enrolToken: string;
}

export class TerminalRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    type: TerminalType;
    name: Localised;
    permissions?: readonly string[];
    config?: Record<string, unknown>;
    soundProfile?: SoundProfile;
  }): CreatedTerminal {
    const id = newTerminalId();
    const enrolToken = newToken(24);
    const at = nowIso();

    this.db
      .prepare(`
        INSERT INTO terminals
          (id, terminal_type, name_json, status, permissions_json, config_json,
           sound_profile_json, enrol_token, public_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, input.type, toDbJson(input.name), TerminalStatus.ACTIVE,
        toDbJson(input.permissions ?? []), toDbJson(input.config ?? {}),
        toDbJson(input.soundProfile ?? defaultSoundProfile(input.type)),
        enrolToken, this.allocatePublicCode(), at, at,
      );

    return { row: this.get(id)!, enrolToken };
  }

  /** Short, unambiguous code printed under a QR so staff can read it aloud. */
  private allocatePublicCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = randomCode(8);
      const clash = this.db
        .prepare('SELECT 1 FROM terminals WHERE public_code = ?')
        .get(code);
      if (!clash) return code;
    }
    throw new Error('could not allocate a unique terminal code');
  }

  get(id: string): TerminalRow | undefined {
    return this.db.prepare('SELECT * FROM terminals WHERE id = ?').get(id) as
      | TerminalRow
      | undefined;
  }

  getByPublicCode(code: string): TerminalRow | undefined {
    return this.db.prepare('SELECT * FROM terminals WHERE public_code = ?').get(code) as
      | TerminalRow
      | undefined;
  }

  list(type?: TerminalType): TerminalRow[] {
    return type
      ? (this.db
          .prepare('SELECT * FROM terminals WHERE terminal_type = ? ORDER BY created_at')
          .all(type) as TerminalRow[])
      : (this.db.prepare('SELECT * FROM terminals ORDER BY terminal_type, created_at')
          .all() as TerminalRow[]);
  }

  update(id: string, patch: {
    name?: Localised;
    status?: string;
    permissions?: readonly string[];
    config?: Record<string, unknown>;
    soundProfile?: SoundProfile;
  }): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { assignments.push('name_json = ?'); values.push(toDbJson(patch.name)); }
    if (patch.status !== undefined) { assignments.push('status = ?'); values.push(patch.status); }
    if (patch.permissions !== undefined) {
      assignments.push('permissions_json = ?'); values.push(toDbJson(patch.permissions));
    }
    if (patch.config !== undefined) {
      assignments.push('config_json = ?'); values.push(toDbJson(patch.config));
    }
    if (patch.soundProfile !== undefined) {
      assignments.push('sound_profile_json = ?'); values.push(toDbJson(patch.soundProfile));
    }
    if (assignments.length === 0) return;

    this.db
      .prepare(`UPDATE terminals SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, nowIso(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM terminals WHERE id = ?').run(id);
  }

  /**
   * Rotate the QR secret, for a terminal whose printed card was lost or whose
   * device left the restaurant. Existing sessions survive; the old printed QR
   * stops enrolling new devices.
   */
  regenerateEnrolToken(id: string): string {
    const token = newToken(24);
    this.db
      .prepare('UPDATE terminals SET enrol_token = ?, updated_at = ? WHERE id = ?')
      .run(token, nowIso(), id);
    return token;
  }

  verifyEnrolToken(row: TerminalRow, token: string): boolean {
    // Constant-time: the token is a bearer secret and this check is reachable
    // by anyone on the restaurant Wi-Fi.
    return constantTimeEquals(row.enrol_token, token);
  }

  touchSeen(id: string): void {
    this.db.prepare('UPDATE terminals SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
  }

  name(row: TerminalRow): Localised {
    return fromDbJson<Localised>(row.name_json, {});
  }

  permissions(row: TerminalRow): string[] {
    return fromDbStringList(row.permissions_json);
  }

  config(row: TerminalRow): Record<string, unknown> {
    return fromDbJson<Record<string, unknown>>(row.config_json, {});
  }

  soundProfile(row: TerminalRow): SoundProfile {
    return fromDbJson<SoundProfile>(row.sound_profile_json, defaultSoundProfile(row.terminal_type));
  }

  /* --------------------------------------------------- terminal sessions */

  createSession(input: {
    terminalId: string;
    ttlSeconds: number;
    clientIp: string | null;
    userAgent: string | null;
  }): string {
    const token = newToken();
    this.db
      .prepare(`
        INSERT INTO terminal_sessions
          (token_hash, terminal_id, created_at, expires_at, client_ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        hashToken(token), input.terminalId, nowIso(),
        new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
        input.clientIp, input.userAgent,
      );
    return token;
  }

  getSession(token: string): TerminalSessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM terminal_sessions WHERE token_hash = ?')
      .get(hashToken(token)) as TerminalSessionRow | undefined;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM terminal_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  /** Used when a terminal is disabled or its device is lost. */
  deleteSessionsForTerminal(terminalId: string): void {
    this.db.prepare('DELETE FROM terminal_sessions WHERE terminal_id = ?').run(terminalId);
  }
}
