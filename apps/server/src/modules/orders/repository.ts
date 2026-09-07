/**
 * Order storage.
 *
 * Orders are immutable history in every way that matters. Item names and unit
 * prices are copied from the menu at the moment of ordering, so re-pricing a
 * burger tomorrow does not change what a diner was charged today, and a product
 * deleted next month still prints correctly on last month's receipt.
 */

import type { Db } from '@qserve/db';
import { fromDbJson, nowIso, toDbJson } from '@qserve/db';
import {
  ActorKind, DEFAULT_CURRENCY, newEntityId, newOrderId, OPEN_ORDER_STATUSES,
  type Actor, type CurrencyConfig, type Localised, type Order, type OrderItem,
  type OrderItemAddon, type OrderItemSelection, type OrderSource, type OrderStatus,
} from '@qserve/shared';

export interface OrderRow {
  id: string;
  order_number: number;
  business_day: string;
  table_id: string | null;
  table_label: string | null;
  status: OrderStatus;
  source: OrderSource;
  created_by_kind: string;
  created_by_user_id: string | null;
  created_by_user_name: string | null;
  created_by_terminal_id: string | null;
  created_by_terminal_name: string | null;
  served_by_user_id: string | null;
  served_by_user_name: string | null;
  paid_by_user_id: string | null;
  paid_by_user_name: string | null;
  paid_by_terminal_id: string | null;
  paid_by_terminal_name: string | null;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  service_minor: number;
  total_minor: number;
  currency_json: string;
  notes: string | null;
  guest_count: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface ItemRow {
  id: string; order_id: string; product_id: string | null; name_json: string;
  unit_price_minor: number; quantity: number; notes: string | null;
  station: string | null; line_total_minor: number; currency_code: string | null;
  currency_display: 'CODE' | 'SYMBOL' | null;
  rate_to_base: number; base_total_minor: number | null;
  sort_order: number; created_at: string;
}

interface SelectionRow {
  id: string; order_item_id: string; option_id: string | null; choice_id: string | null;
  name_json: string; price_delta_minor: number;
}

interface ItemAddonRow {
  id: string; order_item_id: string; addon_id: string | null;
  name_json: string; price_minor: number; quantity: number;
}

export interface PersistItemInput {
  readonly productId: string | null;
  readonly name: Localised;
  readonly unitPriceMinor: number;
  readonly quantity: number;
  readonly notes: string | null;
  readonly station: string | null;
  readonly lineTotalMinor: number;
  /** The currency this line was priced in; null means the base. */
  readonly currencyCode: string | null;
  /** How it is written — code or symbol — captured with the price. */
  readonly currencyDisplay: string | null;
  /**
   * The rate that applied when the order was taken, stored rather than looked
   * up: a bill printed last month must not change because the rate moved.
   */
  readonly rateToBase: number;
  /** The line in the currency the till settles in. */
  readonly baseTotalMinor: number;
  readonly selections: readonly OrderItemSelection[];
  readonly addons: readonly OrderItemAddon[];
}

export interface PersistOrderInput {
  readonly orderNumber: number;
  readonly businessDay: string;
  readonly tableId: string | null;
  readonly tableLabel: string | null;
  readonly status: OrderStatus;
  readonly source: OrderSource;
  readonly createdBy: Actor;
  readonly items: readonly PersistItemInput[];
  readonly totals: {
    subtotalMinor: number; discountMinor: number; taxMinor: number;
    serviceMinor: number; totalMinor: number;
  };
  readonly currency: CurrencyConfig;
  readonly notes: string | null;
  readonly guestCount: number | null;
}

export interface OrderQuery {
  readonly statuses?: readonly OrderStatus[];
  readonly tableId?: string;
  readonly businessDay?: string;
  readonly since?: string;
  readonly until?: string;
  readonly source?: OrderSource;
  readonly openOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export class OrderRepository {
  constructor(private readonly db: Db) {}

  insert(input: PersistOrderInput): Order {
    const orderId = newOrderId();
    const at = nowIso();

    const insertOrder = this.db.prepare(`
      INSERT INTO orders (
        id, order_number, business_day, table_id, table_label, status, source,
        created_by_kind, created_by_user_id, created_by_user_name,
        created_by_terminal_id, created_by_terminal_name,
        subtotal_minor, discount_minor, tax_minor, service_minor, total_minor,
        currency_json, notes, guest_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = this.db.prepare(`
      INSERT INTO order_items
        (id, order_id, product_id, name_json, unit_price_minor, quantity, notes,
         station, line_total_minor, currency_code, currency_display,
         rate_to_base, base_total_minor, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSelection = this.db.prepare(`
      INSERT INTO order_item_selections
        (id, order_item_id, option_id, choice_id, name_json, price_delta_minor)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertAddon = this.db.prepare(`
      INSERT INTO order_item_addons
        (id, order_item_id, addon_id, name_json, price_minor, quantity)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.db.transaction(() => {
      insertOrder.run(
        orderId, input.orderNumber, input.businessDay, input.tableId, input.tableLabel,
        input.status, input.source, input.createdBy.kind,
        input.createdBy.userId, input.createdBy.userName,
        input.createdBy.terminalId, input.createdBy.terminalName,
        input.totals.subtotalMinor, input.totals.discountMinor, input.totals.taxMinor,
        input.totals.serviceMinor, input.totals.totalMinor,
        toDbJson(input.currency), input.notes, input.guestCount, at, at,
      );

      input.items.forEach((item, index) => {
        const itemId = newEntityId('ITM');
        insertItem.run(
          itemId, orderId, item.productId, toDbJson(item.name), item.unitPriceMinor,
          item.quantity, item.notes, item.station, item.lineTotalMinor,
          item.currencyCode, item.currencyDisplay,
          item.rateToBase, item.baseTotalMinor, index, at,
        );
        for (const selection of item.selections) {
          insertSelection.run(
            newEntityId('SEL'), itemId, selection.optionId, selection.choiceId,
            toDbJson(selection.name), selection.priceDeltaMinor,
          );
        }
        for (const addon of item.addons) {
          insertAddon.run(
            newEntityId('IAD'), itemId, addon.addonId,
            toDbJson(addon.name), addon.priceMinor, addon.quantity,
          );
        }
      });
    }).immediate();

    return this.get(orderId)!;
  }

  get(orderId: string): Order | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
      | OrderRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  getRow(orderId: string): OrderRow | undefined {
    return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
      | OrderRow
      | undefined;
  }

  list(query: OrderQuery = {}): Order[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.openOnly) {
      conditions.push(`status IN (${OPEN_ORDER_STATUSES.map(() => '?').join(', ')})`);
      values.push(...OPEN_ORDER_STATUSES);
    } else if (query.statuses?.length) {
      conditions.push(`status IN (${query.statuses.map(() => '?').join(', ')})`);
      values.push(...query.statuses);
    }
    if (query.tableId) { conditions.push('table_id = ?'); values.push(query.tableId); }
    if (query.businessDay) { conditions.push('business_day = ?'); values.push(query.businessDay); }
    if (query.source) { conditions.push('source = ?'); values.push(query.source); }
    if (query.since) { conditions.push('created_at >= ?'); values.push(query.since); }
    if (query.until) { conditions.push('created_at <= ?'); values.push(query.until); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...values, Math.min(query.limit ?? 100, 1000), query.offset ?? 0) as OrderRow[];

    return this.hydrateMany(rows);
  }

  /** Open orders attached to a table. Drives table status (spec §46). */
  openOrdersForTable(tableId: string): Order[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM orders
        WHERE table_id = ? AND status IN (${OPEN_ORDER_STATUSES.map(() => '?').join(', ')})
        ORDER BY created_at
      `)
      .all(tableId, ...OPEN_ORDER_STATUSES) as OrderRow[];
    return this.hydrateMany(rows);
  }

  setStatus(orderId: string, status: OrderStatus, closedAt: string | null = null): void {
    this.db
      .prepare('UPDATE orders SET status = ?, updated_at = ?, closed_at = COALESCE(?, closed_at) WHERE id = ?')
      .run(status, nowIso(), closedAt, orderId);
  }

  setServedBy(orderId: string, actor: Actor): void {
    this.db
      .prepare('UPDATE orders SET served_by_user_id = ?, served_by_user_name = ?, updated_at = ? WHERE id = ?')
      .run(actor.userId, actor.userName, nowIso(), orderId);
  }

  /** Records who took the money, on which station (spec §15). */
  setPaidBy(orderId: string, actor: Actor): void {
    this.db
      .prepare(`
        UPDATE orders SET
          paid_by_user_id = ?, paid_by_user_name = ?,
          paid_by_terminal_id = ?, paid_by_terminal_name = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(actor.userId, actor.userName, actor.terminalId, actor.terminalName, nowIso(), orderId);
  }

  updateTotals(orderId: string, totals: {
    subtotalMinor: number; discountMinor: number; taxMinor: number;
    serviceMinor: number; totalMinor: number;
  }): void {
    this.db
      .prepare(`
        UPDATE orders SET subtotal_minor = ?, discount_minor = ?, tax_minor = ?,
          service_minor = ?, total_minor = ?, updated_at = ? WHERE id = ?
      `)
      .run(
        totals.subtotalMinor, totals.discountMinor, totals.taxMinor,
        totals.serviceMinor, totals.totalMinor, nowIso(), orderId,
      );
  }

  addItems(orderId: string, items: readonly PersistItemInput[]): void {
    const at = nowIso();
    const nextSort = (this.db
      .prepare('SELECT MAX(sort_order) AS max FROM order_items WHERE order_id = ?')
      .get(orderId) as { max: number | null }).max ?? -1;

    const insertItem = this.db.prepare(`
      INSERT INTO order_items
        (id, order_id, product_id, name_json, unit_price_minor, quantity, notes,
         station, line_total_minor, currency_code, currency_display,
         rate_to_base, base_total_minor, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSelection = this.db.prepare(`
      INSERT INTO order_item_selections
        (id, order_item_id, option_id, choice_id, name_json, price_delta_minor)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertAddon = this.db.prepare(`
      INSERT INTO order_item_addons
        (id, order_item_id, addon_id, name_json, price_minor, quantity)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.db.transaction(() => {
      items.forEach((item, index) => {
        const itemId = newEntityId('ITM');
        insertItem.run(
          itemId, orderId, item.productId, toDbJson(item.name), item.unitPriceMinor,
          item.quantity, item.notes, item.station, item.lineTotalMinor,
          item.currencyCode, item.currencyDisplay,
          item.rateToBase, item.baseTotalMinor,
          nextSort + 1 + index, at,
        );
        for (const selection of item.selections) {
          insertSelection.run(
            newEntityId('SEL'), itemId, selection.optionId, selection.choiceId,
            toDbJson(selection.name), selection.priceDeltaMinor,
          );
        }
        for (const addon of item.addons) {
          insertAddon.run(
            newEntityId('IAD'), itemId, addon.addonId,
            toDbJson(addon.name), addon.priceMinor, addon.quantity,
          );
        }
      });
    }).immediate();
  }

  removeItem(orderId: string, itemId: string): void {
    this.db.prepare('DELETE FROM order_items WHERE id = ? AND order_id = ?').run(itemId, orderId);
  }

  itemsOf(orderId: string): OrderItem[] {
    return this.hydrateItems([orderId]).get(orderId) ?? [];
  }

  /* ------------------------------------------------------------ reports */

  countByStatus(businessDay?: string): Record<string, number> {
    const rows = businessDay
      ? this.db
          .prepare('SELECT status, COUNT(*) AS n FROM orders WHERE business_day = ? GROUP BY status')
          .all(businessDay) as { status: string; n: number }[]
      : this.db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')
          .all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }

  salesSummary(since: string, until: string): {
    orders: number; grossMinor: number; taxMinor: number;
    serviceMinor: number; discountMinor: number;
  } {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS orders,
               COALESCE(SUM(total_minor), 0)    AS gross,
               COALESCE(SUM(tax_minor), 0)      AS tax,
               COALESCE(SUM(service_minor), 0)  AS service,
               COALESCE(SUM(discount_minor), 0) AS discount
        FROM orders
        WHERE created_at >= ? AND created_at <= ? AND status IN ('PAID', 'CLOSED')
      `)
      .get(since, until) as {
        orders: number; gross: number; tax: number; service: number; discount: number;
      };
    return {
      orders: row.orders,
      grossMinor: row.gross,
      taxMinor: row.tax,
      serviceMinor: row.service,
      discountMinor: row.discount,
    };
  }

  salesBySource(since: string, until: string): { source: string; orders: number; grossMinor: number }[] {
    return (
      this.db
        .prepare(`
          SELECT source, COUNT(*) AS orders, COALESCE(SUM(total_minor), 0) AS gross
          FROM orders
          WHERE created_at >= ? AND created_at <= ? AND status IN ('PAID', 'CLOSED')
          GROUP BY source ORDER BY gross DESC
        `)
        .all(since, until) as { source: string; orders: number; gross: number }[]
    ).map((row) => ({ source: row.source, orders: row.orders, grossMinor: row.gross }));
  }

  topProducts(since: string, until: string, limit = 20): {
    productId: string | null; name: Localised; quantity: number; grossMinor: number;
  }[] {
    return (
      this.db
        .prepare(`
          SELECT i.product_id, i.name_json,
                 SUM(i.quantity) AS quantity,
                 SUM(i.line_total_minor) AS gross
          FROM order_items i
          JOIN orders o ON o.id = i.order_id
          WHERE o.created_at >= ? AND o.created_at <= ? AND o.status IN ('PAID', 'CLOSED')
          GROUP BY i.product_id, i.name_json
          ORDER BY quantity DESC LIMIT ?
        `)
        .all(since, until, limit) as {
          product_id: string | null; name_json: string; quantity: number; gross: number;
        }[]
    ).map((row) => ({
      productId: row.product_id,
      name: fromDbJson<Localised>(row.name_json, {}),
      quantity: row.quantity,
      grossMinor: row.gross,
    }));
  }

  /* ---------------------------------------------------------- hydration */

  private hydrate(row: OrderRow): Order {
    return this.hydrateMany([row])[0]!;
  }

  private hydrateMany(rows: readonly OrderRow[]): Order[] {
    if (rows.length === 0) return [];
    const itemsByOrder = this.hydrateItems(rows.map((row) => row.id));
    return rows.map((row) => toOrder(row, itemsByOrder.get(row.id) ?? []));
  }

  /** Loads items, selections and add-ons for many orders in three queries. */
  private hydrateItems(orderIds: readonly string[]): Map<string, OrderItem[]> {
    if (orderIds.length === 0) return new Map();
    const placeholders = orderIds.map(() => '?').join(', ');

    const itemRows = this.db
      .prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY sort_order`)
      .all(...orderIds) as ItemRow[];
    if (itemRows.length === 0) return new Map();

    const itemIds = itemRows.map((row) => row.id);
    const itemPlaceholders = itemIds.map(() => '?').join(', ');

    const selectionRows = this.db
      .prepare(`SELECT * FROM order_item_selections WHERE order_item_id IN (${itemPlaceholders})`)
      .all(...itemIds) as SelectionRow[];
    const addonRows = this.db
      .prepare(`SELECT * FROM order_item_addons WHERE order_item_id IN (${itemPlaceholders})`)
      .all(...itemIds) as ItemAddonRow[];

    const selectionsByItem = new Map<string, OrderItemSelection[]>();
    for (const row of selectionRows) {
      const list = selectionsByItem.get(row.order_item_id) ?? [];
      list.push({
        optionId: row.option_id ?? '',
        choiceId: row.choice_id ?? '',
        name: fromDbJson<Localised>(row.name_json, {}),
        priceDeltaMinor: row.price_delta_minor,
      });
      selectionsByItem.set(row.order_item_id, list);
    }

    const addonsByItem = new Map<string, OrderItemAddon[]>();
    for (const row of addonRows) {
      const list = addonsByItem.get(row.order_item_id) ?? [];
      list.push({
        addonId: row.addon_id ?? '',
        name: fromDbJson<Localised>(row.name_json, {}),
        priceMinor: row.price_minor,
        quantity: row.quantity,
      });
      addonsByItem.set(row.order_item_id, list);
    }

    const byOrder = new Map<string, OrderItem[]>();
    for (const row of itemRows) {
      const list = byOrder.get(row.order_id) ?? [];
      list.push({
        id: row.id,
        productId: row.product_id ?? '',
        name: fromDbJson<Localised>(row.name_json, {}),
        unitPriceMinor: row.unit_price_minor,
        quantity: row.quantity,
        selections: selectionsByItem.get(row.id) ?? [],
        addons: addonsByItem.get(row.id) ?? [],
        notes: row.notes,
        station: row.station,
        lineTotalMinor: row.line_total_minor,
        currencyCode: row.currency_code,
        currencyDisplay: row.currency_display,
        rateToBase: row.rate_to_base,
        // Orders taken before the restaurant had a second currency have no
        // stored base total, and for them the line total already is one.
        baseTotalMinor: row.base_total_minor ?? row.line_total_minor,
      });
      byOrder.set(row.order_id, list);
    }
    return byOrder;
  }
}

function actorFrom(
  kind: string,
  userId: string | null,
  userName: string | null,
  terminalId: string | null,
  terminalName: string | null,
): Actor | null {
  if (!userId && !terminalId) return null;
  return {
    kind: kind as ActorKind,
    userId, userName, terminalId, terminalName,
  };
}

export function toOrder(row: OrderRow, items: OrderItem[]): Order {
  return {
    id: row.id,
    number: row.order_number,
    restaurantId: '',
    tableId: row.table_id,
    tableLabel: row.table_label,
    status: row.status,
    source: row.source,
    createdBy: {
      kind: row.created_by_kind as ActorKind,
      userId: row.created_by_user_id,
      userName: row.created_by_user_name,
      terminalId: row.created_by_terminal_id,
      terminalName: row.created_by_terminal_name,
    },
    servedBy: actorFrom(ActorKind.USER, row.served_by_user_id, row.served_by_user_name, null, null),
    paidBy: actorFrom(
      ActorKind.USER, row.paid_by_user_id, row.paid_by_user_name,
      row.paid_by_terminal_id, row.paid_by_terminal_name,
    ),
    items,
    totals: {
      subtotalMinor: row.subtotal_minor,
      discountMinor: row.discount_minor,
      taxMinor: row.tax_minor,
      serviceMinor: row.service_minor,
      totalMinor: row.total_minor,
    },
    currency: fromDbJson<CurrencyConfig>(row.currency_json, DEFAULT_CURRENCY),
    notes: row.notes,
    guestCount: row.guest_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}
