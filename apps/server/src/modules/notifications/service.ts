/**
 * Notifications between stations (spec §21).
 *
 * A restaurant already runs on shouted sentences: "table nine is ready",
 * "table four wants the bill", "we are out of sea bass". On a busy Friday the
 * shout does not carry, the right person is in the walk-in, and the ticket goes
 * cold. This module is the same sentences, routed rather than broadcast.
 *
 * Three properties make it worth having rather than merely present:
 *
 *  - **Addressed, not shouted.** Each notice names the stations it is for. A
 *    kitchen screen is not interrupted by a bill request, and a diner's phone
 *    is never in the audience at all.
 *  - **Kept until acknowledged.** A station that was rebooting when the food
 *    came up still finds it on reconnect. Urgent ones keep asking.
 *  - **A key, never a sentence.** The kitchen screen is in Turkish and the
 *    floor's phone is in Arabic; both render the same row.
 */

import type { Db } from '@qserve/db';
import { fromDbJson, nowIso, toDbJson } from '@qserve/db';
import {
  EventName, newEntityId, NotificationKind, NotificationUrgency, Permission,
  TerminalType, type Actor,
} from '@qserve/shared';
import type { EventBus } from '../../core/event-bus.js';

export interface NotificationRow {
  id: string;
  kind: string;
  urgency: string;
  from_terminal_id: string | null;
  from_terminal_name: string | null;
  from_user_id: string | null;
  from_user_name: string | null;
  to_terminal_types: string;
  to_terminal_id: string | null;
  to_permission: string | null;
  order_id: string | null;
  table_id: string | null;
  table_label: string | null;
  message_key: string;
  params_json: string;
  body: string | null;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_name: string | null;
}

export interface Notification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly urgency: NotificationUrgency;
  readonly from: { terminalId: string | null; terminalName: string | null; userName: string | null };
  readonly audience: {
    terminalTypes: readonly string[];
    terminalId: string | null;
    permission: string | null;
  };
  readonly orderId: string | null;
  readonly tableId: string | null;
  readonly tableLabel: string | null;
  readonly messageKey: string;
  readonly params: Record<string, unknown>;
  readonly body: string | null;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedName: string | null;
}

/**
 * Who hears what, as data.
 *
 * Reading this table is how you answer "does the kitchen get told when a bill
 * is paid?" without tracing five call sites — and adding a notification kind is
 * one entry here plus the place that raises it.
 */
interface Routing {
  readonly urgency: NotificationUrgency;
  readonly terminalTypes: readonly string[];
  /** Narrows the audience further: only stations whose holder may do this. */
  readonly permission?: string;
}

const KITCHEN_SIDE = [TerminalType.KITCHEN, TerminalType.KDS, TerminalType.BAR];
const FLOOR_SIDE = [TerminalType.WAITER, TerminalType.MANAGER];
const TILL_SIDE = [TerminalType.CASHIER, TerminalType.MANAGER];

export const NOTIFICATION_ROUTING: Readonly<Record<string, Routing>> = {
  // A diner pressed the button. Nobody else needs to hear it, and it keeps
  // asking, because an ignored call is the complaint that follows.
  [NotificationKind.WAITER_CALLED]: {
    urgency: NotificationUrgency.URGENT,
    terminalTypes: FLOOR_SIDE,
  },
  [NotificationKind.BILL_REQUESTED]: {
    urgency: NotificationUrgency.URGENT,
    terminalTypes: [...TILL_SIDE, TerminalType.WAITER],
  },
  // Food going cold is the most expensive silence in a restaurant.
  [NotificationKind.ORDER_READY]: {
    urgency: NotificationUrgency.URGENT,
    terminalTypes: FLOOR_SIDE,
  },
  [NotificationKind.ORDER_PLACED]: {
    urgency: NotificationUrgency.ACTION,
    terminalTypes: KITCHEN_SIDE,
  },
  [NotificationKind.ORDER_ACCEPTED]: {
    urgency: NotificationUrgency.INFO,
    terminalTypes: FLOOR_SIDE,
  },
  [NotificationKind.ORDER_REJECTED]: {
    urgency: NotificationUrgency.URGENT,
    terminalTypes: [...FLOOR_SIDE, TerminalType.CASHIER],
  },
  [NotificationKind.ORDER_RUSHED]: {
    urgency: NotificationUrgency.ACTION,
    terminalTypes: KITCHEN_SIDE,
  },
  [NotificationKind.ITEM_UNAVAILABLE]: {
    urgency: NotificationUrgency.ACTION,
    terminalTypes: [...FLOOR_SIDE, TerminalType.CASHIER],
  },
  [NotificationKind.PAYMENT_TAKEN]: {
    urgency: NotificationUrgency.INFO,
    terminalTypes: [TerminalType.MANAGER],
  },
  // A printer that silently stopped is a station that silently stopped.
  [NotificationKind.PRINT_FAILED]: {
    urgency: NotificationUrgency.URGENT,
    terminalTypes: [TerminalType.MANAGER],
    permission: Permission.PRINTING_MANAGE,
  },
  [NotificationKind.HELP_NEEDED]: {
    urgency: NotificationUrgency.URGENT,
    terminalTypes: [TerminalType.MANAGER],
  },
  // A manager talking to the floor reaches every station that has a person.
  [NotificationKind.BROADCAST]: {
    urgency: NotificationUrgency.ACTION,
    terminalTypes: [...KITCHEN_SIDE, ...FLOOR_SIDE, TerminalType.CASHIER],
  },
};

export interface RaiseInput {
  readonly kind: NotificationKind;
  readonly messageKey: string;
  readonly params?: Record<string, unknown>;
  readonly body?: string | null;
  readonly actor?: Actor;
  readonly orderId?: string | null;
  readonly tableId?: string | null;
  readonly tableLabel?: string | null;
  /** Overrides the routing table, for a notice aimed at one station. */
  readonly toTerminalId?: string | null;
  readonly urgency?: NotificationUrgency;
}

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  raise(input: RaiseInput): Notification {
    const routing = NOTIFICATION_ROUTING[input.kind] ?? {
      urgency: NotificationUrgency.INFO,
      terminalTypes: [],
    };
    const id = newEntityId('NTF');
    const at = nowIso();

    this.db
      .prepare(`
        INSERT INTO notifications
          (id, kind, urgency, from_terminal_id, from_terminal_name, from_user_id,
           from_user_name, to_terminal_types, to_terminal_id, to_permission,
           order_id, table_id, table_label, message_key, params_json, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, input.kind, input.urgency ?? routing.urgency,
        input.actor?.terminalId ?? null, input.actor?.terminalName ?? null,
        input.actor?.userId ?? null, input.actor?.userName ?? null,
        toDbJson(routing.terminalTypes), input.toTerminalId ?? null,
        routing.permission ?? null,
        input.orderId ?? null, input.tableId ?? null, input.tableLabel ?? null,
        input.messageKey, toDbJson(input.params ?? {}), input.body ?? null, at,
      );

    const notification = this.get(id)!;
    // Published rather than pushed: the realtime gateway already knows which
    // sockets may see what, and this module should not learn.
    this.bus.publish({
      name: EventName.NOTIFICATION,
      payload: notification,
      ...(input.actor?.terminalId ? { originTerminalId: input.actor.terminalId } : {}),
    });
    return notification;
  }

  get(id: string): Notification | null {
    const row = this.db
      .prepare('SELECT * FROM notifications WHERE id = ?')
      .get(id) as NotificationRow | undefined;
    return row ? toNotification(row) : null;
  }

  /**
   * What a station should be showing right now.
   *
   * Filtered here rather than in the browser: a phone that received everything
   * and hid most of it would still have received it.
   */
  forTerminal(options: {
    terminalType?: string | null;
    terminalId?: string | null;
    permissions?: readonly string[];
    includeAcknowledged?: boolean;
    limit?: number;
  }): Notification[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM notifications
        ${options.includeAcknowledged ? '' : 'WHERE acknowledged_at IS NULL'}
        ORDER BY created_at DESC, rowid DESC LIMIT ?
      `)
      .all(Math.min(options.limit ?? 50, 200)) as NotificationRow[];

    return rows
      .map(toNotification)
      .filter((notification) => this.isFor(notification, options));
  }

  /**
   * Is this station one of the intended recipients? Used both to answer a
   * terminal's own list and to narrow the socket fan-out, so the two can never
   * disagree about who was told.
   */
  isAddressedTo(
    notification: Notification,
    who: {
      terminalType?: string | null;
      terminalId?: string | null;
      permissions?: readonly string[];
    },
  ): boolean {
    return this.isFor(notification, who);
  }

  private isFor(
    notification: Notification,
    who: {
      terminalType?: string | null;
      terminalId?: string | null;
      permissions?: readonly string[];
    },
  ): boolean {
    // Addressed to one station: only that station, whoever else is listening.
    if (notification.audience.terminalId) {
      return notification.audience.terminalId === who.terminalId;
    }
    const { terminalTypes, permission } = notification.audience;

    if (terminalTypes.length > 0) {
      // The console is not a terminal type, so a manager at the desk is
      // recognised by what they may do rather than by what they are sitting at.
      const matchesType = who.terminalType !== null && who.terminalType !== undefined
        && terminalTypes.includes(who.terminalType);
      const managerAtDesk = who.terminalType == null
        && (who.permissions ?? []).some((p) => p === '*' || p.startsWith('orders'));
      if (!matchesType && !managerAtDesk) return false;
    }
    if (permission) {
      const granted = who.permissions ?? [];
      return granted.some((entry) =>
        entry === '*' || entry === permission || (entry.endsWith('.*')
          && permission.startsWith(entry.slice(0, -1))));
    }
    return true;
  }

  /**
   * Somebody heard it. Recorded with a name, because "who acknowledged the call
   * from table nine" is a question that gets asked after a complaint.
   */
  acknowledge(id: string, actor: Actor): Notification | null {
    const existing = this.get(id);
    if (!existing || existing.acknowledgedAt) return existing;

    this.db
      .prepare(`
        UPDATE notifications
        SET acknowledged_at = ?, acknowledged_by = ?, acknowledged_name = ?
        WHERE id = ? AND acknowledged_at IS NULL
      `)
      .run(
        nowIso(), actor.userId ?? actor.terminalId,
        actor.userName ?? actor.terminalName, id,
      );

    const updated = this.get(id)!;
    // Every station drops it at once, so two waiters do not both walk over.
    this.bus.publish({ name: EventName.NOTIFICATION, payload: updated });
    return updated;
  }

  /** Clear the board: a manager silencing everything at the end of service. */
  acknowledgeAll(actor: Actor): number {
    const open = this.db
      .prepare('SELECT id FROM notifications WHERE acknowledged_at IS NULL')
      .all() as { id: string }[];
    for (const row of open) this.acknowledge(row.id, actor);
    return open.length;
  }

  /**
   * Notifications are a working surface, not a record — the audit log is the
   * record. Anything acknowledged and older than the cut-off goes.
   */
  prune(olderThanDays = 3): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = this.db
      .prepare('DELETE FROM notifications WHERE acknowledged_at IS NOT NULL AND created_at < ?')
      .run(cutoff);
    return result.changes;
  }
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    urgency: row.urgency as NotificationUrgency,
    from: {
      terminalId: row.from_terminal_id,
      terminalName: row.from_terminal_name,
      userName: row.from_user_name,
    },
    audience: {
      terminalTypes: fromDbJson<string[]>(row.to_terminal_types, []),
      terminalId: row.to_terminal_id,
      permission: row.to_permission,
    },
    orderId: row.order_id,
    tableId: row.table_id,
    tableLabel: row.table_label,
    messageKey: row.message_key,
    params: fromDbJson<Record<string, unknown>>(row.params_json, {}),
    body: row.body,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedName: row.acknowledged_name,
  };
}
