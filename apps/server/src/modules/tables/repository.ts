/**
 * Dining tables (spec §9, §46).
 *
 * Every table is backed by a TABLE terminal, so a table's QR, session and
 * permissions come from the same machinery as a kitchen screen's. Table status
 * is *derived* from the orders attached to it rather than set by hand, which is
 * why it cannot drift from reality.
 */

import type { Db } from '@qserve/db';
import { nowIso } from '@qserve/db';
import {
  formatTableId, OrderStatus, TableStatus, type Order, type TableStatus as TableStatusType,
} from '@qserve/shared';

export interface TableRow {
  id: string;
  label: string;
  seats: number;
  zone: string | null;
  status: TableStatusType;
  terminal_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export class TableRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    label: string; seats?: number; zone?: string | null; terminalId: string; sortOrder?: number;
  }): TableRow {
    const id = formatTableId(input.label);
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO dining_tables
          (id, label, seats, zone, status, terminal_id, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, input.label, input.seats ?? 4, input.zone ?? null, TableStatus.AVAILABLE,
        input.terminalId, input.sortOrder ?? this.nextSortOrder(), at, at,
      );
    return this.get(id)!;
  }

  get(id: string): TableRow | undefined {
    return this.db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(id) as
      | TableRow
      | undefined;
  }

  getByTerminal(terminalId: string): TableRow | undefined {
    return this.db.prepare('SELECT * FROM dining_tables WHERE terminal_id = ?').get(terminalId) as
      | TableRow
      | undefined;
  }

  list(): TableRow[] {
    return this.db
      .prepare('SELECT * FROM dining_tables ORDER BY sort_order, label')
      .all() as TableRow[];
  }

  update(id: string, patch: {
    label?: string; seats?: number; zone?: string | null; sortOrder?: number;
  }): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.label !== undefined) { assignments.push('label = ?'); values.push(patch.label); }
    if (patch.seats !== undefined) { assignments.push('seats = ?'); values.push(patch.seats); }
    if (patch.zone !== undefined) { assignments.push('zone = ?'); values.push(patch.zone); }
    if (patch.sortOrder !== undefined) { assignments.push('sort_order = ?'); values.push(patch.sortOrder); }
    if (assignments.length === 0) return;
    this.db
      .prepare(`UPDATE dining_tables SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, nowIso(), id);
  }

  setStatus(id: string, status: TableStatusType): void {
    this.db
      .prepare('UPDATE dining_tables SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM dining_tables WHERE id = ?').run(id);
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM dining_tables WHERE id = ?').get(id) !== undefined;
  }

  private nextSortOrder(): number {
    const row = this.db.prepare('SELECT MAX(sort_order) AS max FROM dining_tables').get() as
      { max: number | null };
    return (row.max ?? -1) + 1;
  }
}

/**
 * Project a table's status from the orders currently attached to it.
 *
 * The order of the checks encodes what a floor manager actually needs to see
 * first: food waiting to be collected beats food being cooked, and an unpaid
 * bill beats both, because that is the one that stops the table turning over.
 */
export function deriveTableStatus(openOrders: readonly Order[]): TableStatusType {
  if (openOrders.length === 0) return TableStatus.AVAILABLE;

  const statuses = new Set(openOrders.map((order) => order.status));

  // Served or paid but not yet closed: the bill is the outstanding thing.
  if (statuses.has(OrderStatus.SERVED) || statuses.has(OrderStatus.PAID)) {
    return TableStatus.WAITING_PAYMENT;
  }
  if (statuses.has(OrderStatus.READY)) return TableStatus.READY;
  if (statuses.has(OrderStatus.PREPARING) || statuses.has(OrderStatus.ACCEPTED)) {
    return TableStatus.PREPARING;
  }
  if (statuses.has(OrderStatus.NEW)) return TableStatus.ORDERING;
  return TableStatus.OCCUPIED;
}
