/**
 * Order service — the centre of the operating system.
 *
 * Responsibilities, in the order they matter:
 *
 *  1. **Price on the server.** A client sends product ids and quantities, never
 *     prices. Everything monetary is recomputed here from the menu, so a hacked
 *     phone on the restaurant Wi-Fi cannot order a steak for zero.
 *  2. **Record the source honestly.** `source` and `createdBy` come from the
 *     authenticated session, never from the request body, which is what makes
 *     "who took this order" trustworthy (spec §13, §45).
 *  3. **Enforce the state machine.** Every status change goes through
 *     `assertTransition` and lands in the audit log (spec §18, §19).
 *  4. **Keep tables honest.** Table status is re-derived after every change and
 *     broadcast, so no screen shows a table that is free when it is not.
 */

import {
  assertTransition, canTransition, computeTotals, conflict, EventName, forbidden, grants,
  isTerminalOrderStatus, lineTotal, notFound, OrderSource, OrderStatus, Permission,
  toBaseMinor,
  pickLocalised, validationError,
  type Actor, type CurrencyConfig, type Localised, type Order, type OrderStatus as Status,
  type OrderItemAddon, type OrderItemSelection, type Product,
} from '@qserve/shared';
import type { EventBus } from '../../core/event-bus.js';
import type { AuditRepository } from '../../core/repositories/audit.js';
import type { SettingsRepository } from '../../core/repositories/settings.js';
import type { MenuRepository } from '../menu/repository.js';
import type { TableRepository } from '../tables/repository.js';
import { deriveTableStatus } from '../tables/repository.js';
import { NotificationKind } from '@qserve/shared';
import type { CurrencyRepository } from '../../core/repositories/currencies.js';

/** The subset of the notification service this module needs, and no more. */
export interface NotifyInput {
  readonly kind: string;
  readonly messageKey: string;
  readonly params?: Record<string, unknown>;
  readonly actor?: Actor;
  readonly orderId?: string | null;
  readonly tableId?: string | null;
  readonly tableLabel?: string | null;
}
import type { OrderRepository, PersistItemInput } from './repository.js';

export interface RequestedItem {
  readonly productId: string;
  readonly quantity: number;
  /** Chosen option values, as `{ optionId, choiceId }`. */
  readonly selections: readonly { optionId: string; choiceId: string }[];
  readonly addons: readonly { addonId: string; quantity: number }[];
  readonly notes: string | null;
}

export interface CreateOrderInput {
  readonly tableId: string | null;
  readonly source: OrderSource;
  readonly actor: Actor;
  readonly items: readonly RequestedItem[];
  readonly notes: string | null;
  readonly guestCount: number | null;
  readonly clientIp: string | null;
}

export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly menu: MenuRepository,
    private readonly tables: TableRepository,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditRepository,
    private readonly bus: EventBus,
    private readonly currencies: CurrencyRepository,
  ) {}

  /**
   * Telling other stations what happened. Set after construction because the
   * notification service publishes onto the same bus this service writes to,
   * and neither should own the other.
   */
  private notify: ((input: NotifyInput) => void) | null = null;

  setNotifier(notify: (input: NotifyInput) => void): void {
    this.notify = notify;
  }

  /**
   * How much has been captured against an order. Supplied by the payments
   * module after construction, because the two services need each other and
   * neither should own the other.
   */
  private paidTotal: ((orderId: string) => number) | null = null;

  setPaidTotalProvider(provider: (orderId: string) => number): void {
    this.paidTotal = provider;
  }

  /** True when the captured payments cover the order in full. */
  isSettled(orderId: string): boolean {
    if (!this.paidTotal) return false;
    const order = this.orders.get(orderId);
    return order !== null && this.paidTotal(orderId) >= order.totals.totalMinor;
  }

  /* -------------------------------------------------------------- pricing */

  /**
   * Turn a request into priced lines. Throws on anything the menu does not
   * support: an unknown product, an unavailable one, a choice that does not
   * belong to the option, or a required option left unanswered.
   */
  private priceItems(requested: readonly RequestedItem[]): PersistItemInput[] {
    if (requested.length === 0) {
      throw validationError('an order needs at least one item', { field: 'items' });
    }

    return requested.map((request, index) => {
      const product = this.menu.getProduct(request.productId);
      if (!product) throw notFound('product', request.productId);
      if (!product.available || !product.visible) {
        throw conflict('this item is not currently available', {
          field: `items[${index}]`, productId: product.id,
        });
      }
      if (!Number.isInteger(request.quantity) || request.quantity < 1 || request.quantity > 999) {
        throw validationError('quantity must be between 1 and 999', { field: `items[${index}].quantity` });
      }

      const selections = this.resolveSelections(product, request.selections, index);
      const addons = this.resolveAddons(product, request.addons, index);

      const modifiers = [
        ...selections.map((selection) => selection.priceDeltaMinor),
        // An add-on taken twice costs twice; its price is per unit of the line.
        ...addons.map((addon) => addon.priceMinor * addon.quantity),
      ];

      // A product's options and add-ons are priced in the product's own
      // currency — a "large" that costs 5 more costs 5 of whatever the dish is
      // priced in. So one currency governs the whole line.
      const base = this.currencies.base();
      const currency = this.currencies.resolve(product.currencyCode);
      const lineTotalMinor = lineTotal(product.priceMinor, modifiers, request.quantity);

      return {
        productId: product.id,
        name: product.name,
        unitPriceMinor: product.priceMinor,
        quantity: request.quantity,
        notes: request.notes?.trim() || null,
        station: product.station,
        lineTotalMinor,
        currencyCode: currency.isBase ? null : currency.code,
        rateToBase: currency.rateToBase,
        // Converted once, now, and stored: the bill is settled at the rate that
        // was true when the food was ordered, not the rate at closing time.
        baseTotalMinor: toBaseMinor(
          lineTotalMinor, currency.rateToBase, base.decimals, currency.decimals,
        ),
        selections,
        addons,
      };
    });
  }

  private resolveSelections(
    product: Product,
    requested: readonly { optionId: string; choiceId: string }[],
    itemIndex: number,
  ): OrderItemSelection[] {
    const chosen: OrderItemSelection[] = [];
    const countByOption = new Map<string, number>();

    for (const request of requested) {
      const option = product.options.find((o) => o.id === request.optionId);
      if (!option) {
        throw validationError('unknown option for this product', {
          field: `items[${itemIndex}].selections`, optionId: request.optionId,
        });
      }
      const choice = option.choices.find((c) => c.id === request.choiceId);
      if (!choice) {
        throw validationError('unknown choice for this option', {
          field: `items[${itemIndex}].selections`, choiceId: request.choiceId,
        });
      }
      if (!choice.available) {
        throw conflict('this choice is not currently available', { choiceId: choice.id });
      }

      countByOption.set(option.id, (countByOption.get(option.id) ?? 0) + 1);
      chosen.push({
        optionId: option.id,
        choiceId: choice.id,
        name: choice.name,
        priceDeltaMinor: choice.priceDeltaMinor,
      });
    }

    for (const option of product.options) {
      const count = countByOption.get(option.id) ?? 0;
      if (option.required && count === 0) {
        throw validationError('a required option was not answered', {
          field: `items[${itemIndex}].selections`, optionId: option.id,
        });
      }
      if (count > 0 && count < option.minSelect) {
        throw validationError(`option needs at least ${option.minSelect} choices`, {
          field: `items[${itemIndex}].selections`, optionId: option.id,
        });
      }
      if (count > option.maxSelect) {
        throw validationError(`option accepts at most ${option.maxSelect} choices`, {
          field: `items[${itemIndex}].selections`, optionId: option.id,
        });
      }
    }
    return chosen;
  }

  private resolveAddons(
    product: Product,
    requested: readonly { addonId: string; quantity: number }[],
    itemIndex: number,
  ): OrderItemAddon[] {
    return requested.map((request) => {
      const addon = product.addons.find((a) => a.id === request.addonId);
      if (!addon) {
        throw validationError('this add-on is not offered with this product', {
          field: `items[${itemIndex}].addons`, addonId: request.addonId,
        });
      }
      if (!addon.available) {
        throw conflict('this add-on is not currently available', { addonId: addon.id });
      }
      const quantity = request.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        throw validationError('add-on quantity must be between 1 and 99', {
          field: `items[${itemIndex}].addons`,
        });
      }
      return {
        addonId: addon.id,
        name: addon.name,
        priceMinor: addon.priceMinor,
        quantity,
      };
    });
  }

  private currency(): CurrencyConfig {
    return this.settings.profile()!.currency;
  }

  private totalsFor(lines: readonly PersistItemInput[], discountMinor = 0): {
    subtotalMinor: number; discountMinor: number; taxMinor: number;
    serviceMinor: number; totalMinor: number;
  } {
    const profile = this.settings.profile()!;
    // Totals are always in the base currency: tax, service and the amount the
    // till takes have to be one number in one currency, whatever the lines
    // were priced in.
    return computeTotals({
      lineTotalsMinor: lines.map((line) => line.baseTotalMinor),
      discountMinor,
      taxRatePercent: profile.taxRatePercent,
      serviceRatePercent: profile.serviceRatePercent,
      taxInclusive: profile.taxInclusive,
    });
  }

  /* --------------------------------------------------------------- create */

  create(input: CreateOrderInput): Order {
    const lines = this.priceItems(input.items);

    let tableLabel: string | null = null;
    if (input.tableId) {
      const table = this.tables.get(input.tableId);
      if (!table) throw notFound('table', input.tableId);
      tableLabel = table.label;
    }

    const businessDay = businessDayFor(new Date());
    const counterName = this.settings.get<boolean>('orders.dailyNumberReset')
      ? `order_number:${businessDay}`
      : 'order_number';
    const orderNumber = this.settings.nextCounter(counterName);

    const autoAccept =
      input.source !== OrderSource.CUSTOMER ||
      this.settings.get<boolean>('orders.autoAcceptFromCustomer');

    const order = this.orders.insert({
      orderNumber,
      businessDay,
      tableId: input.tableId,
      tableLabel,
      status: autoAccept ? OrderStatus.ACCEPTED : OrderStatus.NEW,
      source: input.source,
      createdBy: input.actor,
      items: lines,
      totals: this.totalsFor(lines),
      currency: this.currency(),
      notes: input.notes,
      guestCount: input.guestCount,
    });

    this.audit.record({
      action: 'order.created',
      actor: input.actor,
      entityType: 'order',
      entityId: order.id,
      orderId: order.id,
      tableId: input.tableId,
      after: { number: order.number, status: order.status, total: order.totals.totalMinor },
      detail: { source: input.source, itemCount: lines.length },
      clientIp: input.clientIp,
    });

    this.bus.publish({
      name: EventName.ORDER_CREATED,
      payload: order,
      originTerminalId: input.actor.terminalId,
    });

    // The kitchen is told a ticket landed. A board that lights up is the point
    // of a kitchen screen; a board that has to be watched is not.
    this.notify?.({
      kind: NotificationKind.ORDER_PLACED,
      messageKey: 'notify.order_placed',
      params: { order: order.number, table: order.tableLabel ?? '' },
      actor: input.actor,
      orderId: order.id,
      tableId: order.tableId,
      tableLabel: order.tableLabel,
    });

    this.refreshTableStatus(input.tableId, input.actor.terminalId);
    return order;
  }

  /* ------------------------------------------------------- status changes */

  /**
   * Move an order to `next`. The transition table decides whether the move is
   * legal and which permission it needs; this method never trusts the caller to
   * have checked either.
   */
  changeStatus(input: {
    orderId: string;
    next: Status;
    actor: Actor;
    permissions: readonly string[];
    reason?: string | null;
    clientIp: string | null;
  }): Order {
    const current = this.orders.get(input.orderId);
    if (!current) throw notFound('order', input.orderId);

    const transition = assertTransition(current.status, input.next);
    if (!grants(input.permissions, transition.permission)) {
      throw forbidden(transition.permission);
    }

    const closing = input.next === OrderStatus.CLOSED || isTerminalOrderStatus(input.next);
    this.orders.setStatus(input.orderId, input.next, closing ? new Date().toISOString() : null);

    // Serving is a person's act, so record who did it while we know.
    if (input.next === OrderStatus.SERVED && input.actor.userId) {
      this.orders.setServedBy(input.orderId, input.actor);
    }

    this.audit.record({
      action: 'order.status_changed',
      actor: input.actor,
      entityType: 'order',
      entityId: input.orderId,
      orderId: input.orderId,
      tableId: current.tableId,
      before: { status: current.status },
      after: { status: input.next },
      detail: { reason: input.reason ?? null, transition: `${current.status}->${input.next}` },
      clientIp: input.clientIp,
    });

    const updated = this.orders.get(input.orderId)!;
    this.bus.publish({
      name: EventName.ORDER_STATUS_CHANGED,
      payload: { order: updated, previousStatus: current.status },
      originTerminalId: input.actor.terminalId,
    });

    // Three of the transitions are somebody else's cue to move.
    const CUES: Readonly<Record<string, string>> = {
      [OrderStatus.ACCEPTED]: NotificationKind.ORDER_ACCEPTED,
      [OrderStatus.READY]: NotificationKind.ORDER_READY,
      [OrderStatus.REJECTED]: NotificationKind.ORDER_REJECTED,
    };
    const cue = CUES[input.next];
    if (cue) {
      this.notify?.({
        kind: cue,
        messageKey: `notify.${cue.toLowerCase()}`,
        params: { order: updated.number, table: updated.tableLabel ?? '' },
        actor: input.actor,
        orderId: updated.id,
        tableId: updated.tableId,
        tableLabel: updated.tableLabel,
      });
    }

    this.refreshTableStatus(current.tableId, input.actor.terminalId);

    // A pre-paid order (counter service, or a diner who settled while the food
    // was still cooking) should not need a second visit from the cashier: once
    // it reaches a state from which PAID is legal, it advances by itself.
    if (
      input.next !== OrderStatus.PAID &&
      canTransition(input.next, OrderStatus.PAID) &&
      this.isSettled(input.orderId)
    ) {
      return this.changeStatus({
        orderId: input.orderId,
        next: OrderStatus.PAID,
        actor: input.actor,
        permissions: [...input.permissions, Permission.PAYMENTS_CREATE],
        reason: 'the bill was already settled in full',
        clientIp: input.clientIp,
      });
    }

    return updated;
  }

  /* ------------------------------------------------------------- editing */

  addItems(input: {
    orderId: string;
    items: readonly RequestedItem[];
    actor: Actor;
    clientIp: string | null;
  }): Order {
    const order = this.orders.get(input.orderId);
    if (!order) throw notFound('order', input.orderId);
    if (isTerminalOrderStatus(order.status) || order.status === OrderStatus.PAID) {
      throw conflict('items cannot be added to an order in this state', { status: order.status });
    }

    const lines = this.priceItems(input.items);
    this.orders.addItems(input.orderId, lines);

    const refreshed = this.orders.get(input.orderId)!;
    this.orders.updateTotals(input.orderId, this.totalsFor(
      refreshed.items.map((item) => ({ lineTotalMinor: item.lineTotalMinor } as PersistItemInput)),
      order.totals.discountMinor,
    ));

    this.audit.record({
      action: 'order.items_added',
      actor: input.actor,
      entityType: 'order',
      entityId: input.orderId,
      orderId: input.orderId,
      tableId: order.tableId,
      detail: { addedCount: lines.length },
      clientIp: input.clientIp,
    });

    const result = this.orders.get(input.orderId)!;
    this.bus.publish({
      name: EventName.ORDER_ITEMS_CHANGED,
      payload: result,
      originTerminalId: input.actor.terminalId,
    });
    return result;
  }

  removeItem(input: {
    orderId: string; itemId: string; actor: Actor; clientIp: string | null;
  }): Order {
    const order = this.orders.get(input.orderId);
    if (!order) throw notFound('order', input.orderId);
    if (order.status === OrderStatus.PAID || isTerminalOrderStatus(order.status)) {
      throw conflict('items cannot be removed from an order in this state', { status: order.status });
    }
    const item = order.items.find((candidate) => candidate.id === input.itemId);
    if (!item) throw notFound('order item', input.itemId);
    if (order.items.length === 1) {
      throw conflict('an order must keep at least one item; cancel it instead');
    }

    this.orders.removeItem(input.orderId, input.itemId);
    const refreshed = this.orders.get(input.orderId)!;
    this.orders.updateTotals(input.orderId, this.totalsFor(
      refreshed.items.map((line) => ({ lineTotalMinor: line.lineTotalMinor } as PersistItemInput)),
      order.totals.discountMinor,
    ));

    this.audit.record({
      action: 'order.item_removed',
      actor: input.actor,
      entityType: 'order',
      entityId: input.orderId,
      orderId: input.orderId,
      tableId: order.tableId,
      before: { item: { name: item.name, quantity: item.quantity, total: item.lineTotalMinor } },
      clientIp: input.clientIp,
    });

    const result = this.orders.get(input.orderId)!;
    this.bus.publish({
      name: EventName.ORDER_ITEMS_CHANGED,
      payload: result,
      originTerminalId: input.actor.terminalId,
    });
    return result;
  }

  applyDiscount(input: {
    orderId: string; discountMinor: number; actor: Actor; clientIp: string | null;
  }): Order {
    const order = this.orders.get(input.orderId);
    if (!order) throw notFound('order', input.orderId);
    if (order.status === OrderStatus.PAID || isTerminalOrderStatus(order.status)) {
      throw conflict('an order in this state can no longer be discounted', { status: order.status });
    }
    if (input.discountMinor < 0 || input.discountMinor > order.totals.subtotalMinor) {
      throw validationError('discount must be between zero and the order subtotal', {
        field: 'discountMinor',
      });
    }

    this.orders.updateTotals(input.orderId, this.totalsFor(
      order.items.map((item) => ({ lineTotalMinor: item.lineTotalMinor } as PersistItemInput)),
      input.discountMinor,
    ));

    this.audit.record({
      action: 'order.discount_applied',
      actor: input.actor,
      entityType: 'order',
      entityId: input.orderId,
      orderId: input.orderId,
      before: { discountMinor: order.totals.discountMinor },
      after: { discountMinor: input.discountMinor },
      clientIp: input.clientIp,
    });

    const result = this.orders.get(input.orderId)!;
    this.bus.publish({ name: EventName.ORDER_UPDATED, payload: result });
    return result;
  }

  /* --------------------------------------------------------------- tables */

  /** Re-derive and broadcast a table's status. Called after every change. */
  refreshTableStatus(tableId: string | null, originTerminalId?: string | null): void {
    if (!tableId) return;
    const table = this.tables.get(tableId);
    if (!table) return;

    const openOrders = this.orders.openOrdersForTable(tableId);
    const status = deriveTableStatus(openOrders);
    if (status === table.status) return;

    this.tables.setStatus(tableId, status);
    this.bus.publish({
      name: EventName.TABLE_STATUS_CHANGED,
      payload: {
        tableId,
        label: table.label,
        status,
        activeOrderIds: openOrders.map((order) => order.id),
      },
      ...(originTerminalId ? { originTerminalId } : {}),
    });
  }

  /* ---------------------------------------------------------------- views */

  /** Kitchen queue: what to cook, oldest first, with the source badge. */
  kitchenQueue(statuses: readonly Status[], locale: string): {
    order: Order; ageSeconds: number; urgent: boolean; sourceLabel: string;
  }[] {
    const urgentAfter = this.settings.get<number>('kitchen.urgentAfterMinutes') * 60;
    const now = Date.now();

    return this.orders
      .list({ statuses, limit: 200 })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((order) => {
        const ageSeconds = Math.floor((now - new Date(order.createdAt).getTime()) / 1000);
        return {
          order,
          ageSeconds,
          urgent: ageSeconds > urgentAfter,
          sourceLabel: describeSource(order, locale),
        };
      });
  }

  get repository(): OrderRepository {
    return this.orders;
  }
}

/**
 * "WAITER — Ahmed", "CUSTOMER", "CASHIER — Sara". Rendered from the persisted
 * source and actor so the kitchen sees who is responsible for an order without
 * the kitchen screen having to know the permission model.
 */
export function describeSource(order: Order, _locale: string): string {
  const who = order.createdBy.userName ?? order.createdBy.terminalName;
  return who ? `${order.source} — ${who}` : order.source;
}

/**
 * The business day an order belongs to. Restaurants trading past midnight would
 * otherwise split one service across two report days; the cutover is 04:00
 * local time, which is after even a late kitchen has closed.
 */
export function businessDayFor(date: Date): string {
  const shifted = new Date(date.getTime() - 4 * 60 * 60 * 1000);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Localised item name for tickets and receipts. */
export const itemLabel = (name: Localised, locale: string, fallback: string): string =>
  pickLocalised(name, locale, fallback);

export const ORDER_PERMISSIONS = Permission;
