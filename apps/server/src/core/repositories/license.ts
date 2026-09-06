/**
 * Local licence state.
 *
 * These rows are a *cache* for display; the signed certificate on disk is the
 * authority. Nothing here grants a capability — only `LicenseGate.evaluate()`
 * does, and only after verifying a signature.
 *
 * Note what is not stored in the database: the licence key itself. It lives in
 * `data/restaurant/license/key`, outside the database and therefore outside
 * every backup, so a backup handed to a support agent never carries the
 * restaurant's bearer credential.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Db } from '@qserve/db';
import { fromDbJson, nowIso, toDbJson } from '@qserve/db';
import type { ActivationCertificatePayload, CertificateVerdict } from '@qserve/shared';
import type { Paths } from '../paths.js';

export interface LicenseStateRow {
  singleton: number;
  license_id: string | null;
  license_type: string | null;
  status: string;
  certificate_json: string | null;
  activated_at: string | null;
  transfer_count: number;
  last_verdict: string;
  last_checked_at: string | null;
  key_hint: string | null;
  updated_at: string;
}

export class LicenseRepository {
  constructor(private readonly db: Db, private readonly paths: Paths) {}

  state(): LicenseStateRow {
    return this.db.prepare('SELECT * FROM license_state WHERE singleton = 1').get() as LicenseStateRow;
  }

  saveVerdict(input: {
    verdict: CertificateVerdict;
    payload: ActivationCertificatePayload | null;
  }): void {
    const payload = input.payload;
    this.db
      .prepare(`
        UPDATE license_state SET
          license_id      = COALESCE(?, license_id),
          license_type    = COALESCE(?, license_type),
          status          = ?,
          certificate_json = COALESCE(?, certificate_json),
          activated_at    = COALESCE(?, activated_at),
          transfer_count  = COALESCE(?, transfer_count),
          last_verdict    = ?,
          last_checked_at = ?,
          updated_at      = ?
        WHERE singleton = 1
      `)
      .run(
        payload?.licenseId ?? null,
        payload?.licenseType ?? null,
        payload ? 'ACTIVE' : 'NONE',
        payload ? toDbJson(payload) : null,
        payload?.issuedAt ?? null,
        payload?.transferCount ?? null,
        input.verdict,
        nowIso(),
        nowIso(),
      );
  }

  /** Wipe the cached state after a deactivation, keeping the row itself. */
  clear(): void {
    this.db
      .prepare(`
        UPDATE license_state SET
          license_id = NULL, license_type = NULL, status = 'NONE',
          certificate_json = NULL, activated_at = NULL,
          last_verdict = 'MISSING', last_checked_at = ?, key_hint = NULL, updated_at = ?
        WHERE singleton = 1
      `)
      .run(nowIso(), nowIso());
  }

  certificatePayload(): ActivationCertificatePayload | null {
    const row = this.state();
    return row.certificate_json
      ? fromDbJson<ActivationCertificatePayload | null>(row.certificate_json, null)
      : null;
  }

  setKeyHint(hint: string | null): void {
    this.db
      .prepare('UPDATE license_state SET key_hint = ?, updated_at = ? WHERE singleton = 1')
      .run(hint, nowIso());
  }

  /* ------------------------------------------------- licence key on disk */

  /**
   * Remembering the key lets the owner deactivate before moving to a new PC
   * without hunting for the original email. It is stored 0600 outside the
   * database so it is never swept into a backup.
   */
  rememberKey(licenseKey: string): void {
    writeFileSync(this.paths.licenseKeyFile, `${licenseKey}\n`, { mode: 0o600 });
    chmodSync(this.paths.licenseKeyFile, 0o600);
    this.setKeyHint(licenseKey.slice(-5));
  }

  rememberedKey(): string | null {
    if (!existsSync(this.paths.licenseKeyFile)) return null;
    const value = readFileSync(this.paths.licenseKeyFile, 'utf8').trim();
    return value || null;
  }
}
