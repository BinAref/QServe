/**
 * Audit trail (spec §19).
 *
 * Append-only by construction: this repository exposes `record` and reads, and
 * no update or delete. Every state change that a restaurant might later argue
 * about — who took the order, who accepted it, who took the money — lands here
 * with the actor, the station, the timestamp and the before/after values.
 */

import type { Db } from '@qserve/db';
import { fromDbJson, nowIso, toDbJson } from '@qserve/db';
import { newEntityId, type Actor, type ActorKind, type AuditLogEntry } from '@qserve/shared';

export interface AuditRow {
  id: string;
  at: string;
  action: string;
  actor_kind: string;
  actor_user_id: string | null;
  actor_user_name: string | null;
  actor_terminal_id: string | null;
  actor_terminal_name: string | null;
  entity_type: string;
  entity_id: string | null;
  order_id: string | null;
  table_id: string | null;
  before_json: string | null;
  after_json: string | null;
  detail_json: string;
  client_ip: string | null;
}

export interface AuditInput {
  readonly action: string;
  readonly actor: Actor;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly orderId?: string | null;
  readonly tableId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly detail?: Record<string, unknown>;
  readonly clientIp?: string | null;
}

export interface AuditQuery {
  readonly orderId?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly action?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  record(input: AuditInput): void {
    this.db
      .prepare(`
        INSERT INTO audit_log
          (id, at, action, actor_kind, actor_user_id, actor_user_name,
           actor_terminal_id, actor_terminal_name, entity_type, entity_id,
           order_id, table_id, before_json, after_json, detail_json, client_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        newEntityId('AUD'), nowIso(), input.action, input.actor.kind,
        input.actor.userId, input.actor.userName,
        input.actor.terminalId, input.actor.terminalName,
        input.entityType, input.entityId ?? null,
        input.orderId ?? null, input.tableId ?? null,
        input.before === undefined ? null : toDbJson(input.before),
        input.after === undefined ? null : toDbJson(input.after),
        toDbJson(input.detail ?? {}), input.clientIp ?? null,
      );
  }

  query(query: AuditQuery = {}): AuditLogEntry[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.orderId) { conditions.push('order_id = ?'); values.push(query.orderId); }
    if (query.entityType) { conditions.push('entity_type = ?'); values.push(query.entityType); }
    if (query.entityId) { conditions.push('entity_id = ?'); values.push(query.entityId); }
    if (query.action) { conditions.push('action = ?'); values.push(query.action); }
    if (query.since) { conditions.push('at >= ?'); values.push(query.since); }
    if (query.until) { conditions.push('at <= ?'); values.push(query.until); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      // rowid, not id: ids carry random suffixes, so within one millisecond
      // they would order arbitrarily. rowid is insertion order.
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, Math.min(query.limit ?? 100, 1000), query.offset ?? 0) as AuditRow[];

    return rows.map(toEntry);
  }

  /** Chronological history for one order — the timeline the spec sketches. */
  orderTimeline(orderId: string): AuditLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE order_id = ? ORDER BY at ASC, rowid ASC')
      .all(orderId) as AuditRow[];
    return rows.map(toEntry);
  }
}

function toEntry(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    at: row.at,
    action: row.action,
    actor: {
      kind: row.actor_kind as ActorKind,
      userId: row.actor_user_id,
      userName: row.actor_user_name,
      terminalId: row.actor_terminal_id,
      terminalName: row.actor_terminal_name,
    },
    entityType: row.entity_type,
    entityId: row.entity_id,
    orderId: row.order_id,
    tableId: row.table_id,
    before: row.before_json === null ? null : fromDbJson<unknown>(row.before_json, null),
    after: row.after_json === null ? null : fromDbJson<unknown>(row.after_json, null),
    detail: fromDbJson<Record<string, unknown>>(row.detail_json, {}),
  };
}
