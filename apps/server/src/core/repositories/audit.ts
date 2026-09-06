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
  /** Everything one person did — the question an owner actually asks. */
  readonly actorUserId?: string;
  readonly actorKind?: string;
  readonly terminalId?: string;
  /** Substring match over the action, the actor's name and the entity id. */
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** The values present in the log, so the console can offer real filters. */
export interface AuditFacets {
  readonly actions: string[];
  readonly entityTypes: string[];
  readonly actors: { userId: string; userName: string }[];
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

  /** Shared WHERE builder, so `query` and `count` can never disagree. */
  private conditions(query: AuditQuery): { where: string; values: unknown[] } {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.orderId) { conditions.push('order_id = ?'); values.push(query.orderId); }
    if (query.entityType) { conditions.push('entity_type = ?'); values.push(query.entityType); }
    if (query.entityId) { conditions.push('entity_id = ?'); values.push(query.entityId); }
    if (query.action) { conditions.push('action = ?'); values.push(query.action); }
    if (query.since) { conditions.push('at >= ?'); values.push(query.since); }
    if (query.until) { conditions.push('at <= ?'); values.push(query.until); }
    if (query.actorUserId) { conditions.push('actor_user_id = ?'); values.push(query.actorUserId); }
    if (query.actorKind) { conditions.push('actor_kind = ?'); values.push(query.actorKind); }
    if (query.terminalId) {
      conditions.push('actor_terminal_id = ?');
      values.push(query.terminalId);
    }
    if (query.search) {
      // Deliberately narrow: an owner looking for "burger" wants the entity,
      // not a match inside a JSON blob they cannot read.
      conditions.push(`(
        action LIKE ? OR actor_user_name LIKE ? OR actor_terminal_name LIKE ?
        OR entity_id LIKE ? OR entity_type LIKE ?
      )`);
      const like = `%${query.search}%`;
      values.push(like, like, like, like, like);
    }
    return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
  }

  query(query: AuditQuery = {}): AuditLogEntry[] {
    const { where, values } = this.conditions(query);
    const rows = this.db
      // rowid, not id: ids carry random suffixes, so within one millisecond
      // they would order arbitrarily. rowid is insertion order.
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, Math.min(query.limit ?? 100, 1000), query.offset ?? 0) as AuditRow[];

    return rows.map(toEntry);
  }

  /** Total matching rows, so the console can page rather than truncate. */
  count(query: AuditQuery = {}): number {
    const { where, values } = this.conditions(query);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`)
      .get(...values) as { n: number };
    return row.n;
  }

  /**
   * What the log actually contains. The filter lists are built from the data
   * rather than from a hard-coded vocabulary, so a module added later appears
   * in the console's filters without anybody editing a dropdown.
   */
  facets(): AuditFacets {
    const actions = (this.db
      .prepare('SELECT DISTINCT action FROM audit_log ORDER BY action')
      .all() as { action: string }[]).map((row) => row.action);

    const entityTypes = (this.db
      .prepare('SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type')
      .all() as { entity_type: string }[]).map((row) => row.entity_type);

    const actors = (this.db
      .prepare(`SELECT actor_user_id AS userId, MAX(actor_user_name) AS userName
                FROM audit_log WHERE actor_user_id IS NOT NULL
                GROUP BY actor_user_id ORDER BY userName`)
      .all() as { userId: string; userName: string | null }[])
      .map((row) => ({ userId: row.userId, userName: row.userName ?? row.userId }));

    return { actions, entityTypes, actors };
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
