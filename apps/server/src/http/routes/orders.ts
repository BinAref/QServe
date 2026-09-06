/**
 * Orders, tables and the kitchen/cashier/waiter views over them.
 *
 * The single most important line in this file is in `POST /orders`: the order's
 * `source` and `createdBy` are taken from the authenticated session, never from
 * the request body. That is what makes "Table 05 · Source: WAITER — Ahmed"
 * something a manager can rely on rather than something a client asserted.
 */

import {
  ActorKind, asObject, Capability, conflict, forbidden, grants, KITCHEN_QUEUE_STATUSES,
  nextStatuses, notFound, optionalNumber, optionalString, OrderSource, OrderStatus,
  ORDER_STATUSES, Permission, requireArray, requireEnum, requireNumber, requireString,
  type OrderStatus as Status,
} from '@qserve/shared';
import { Router } from '@qserve/http';
import type { Services } from '../../container.js';
import type { AppContext, AppState } from '../../core/security.js';
import type { RequestedItem } from '../../modules/orders/service.js';

/**
 * Decide the order source from the session, not the payload.
 *
 * A table terminal orders as CUSTOMER; a signed-in waiter orders as WAITER even
 * if they are standing at a cashier station, because the accountable party is
 * the person. A manager gets MANAGER. Nothing here can be spoofed by a client.
 */
function sourceFor(ctx: AppContext, services: Services): OrderSource {
  const auth = ctx.state.auth!;
  const terminalType = auth.terminal?.terminal_type;

  if (auth.user) {
    const roles = services.access.roleKeysForUser(auth.user.id);
    if (roles.includes('WAITER')) return OrderSource.WAITER;
    if (roles.includes('CASHIER')) return OrderSource.CASHIER;
    if (roles.includes('MANAGER') || roles.includes('ADMIN')) return OrderSource.MANAGER;
  }
  switch (terminalType) {
    case 'TABLE': return OrderSource.CUSTOMER;
    case 'WAITER': return OrderSource.WAITER;
    case 'CASHIER': return OrderSource.CASHIER;
    case 'MANAGER': return OrderSource.MANAGER;
    default: return auth.user ? OrderSource.MANAGER : OrderSource.CUSTOMER;
  }
}

function parseItems(body: Record<string, unknown>): RequestedItem[] {
  const raw = requireArray(body, 'items', { min: 1, max: 200 });

  return raw.map((entry, index) => {
    const item = asObject(entry, `items[${index}]`);
    const selections = item['selections'] !== undefined
      ? requireArray(item, 'selections', { max: 30 }).map((value, selectionIndex) => {
          const selection = asObject(value, `items[${index}].selections[${selectionIndex}]`);
          return {
            optionId: requireString(selection, 'optionId', { max: 64 }),
            choiceId: requireString(selection, 'choiceId', { max: 64 }),
          };
        })
      : [];

    const addons = item['addons'] !== undefined
      ? requireArray(item, 'addons', { max: 30 }).map((value, addonIndex) => {
          const addon = asObject(value, `items[${index}].addons[${addonIndex}]`);
          return {
            addonId: requireString(addon, 'addonId', { max: 64 }),
            quantity: optionalNumber(addon, 'quantity', { min: 1, max: 99 }) ?? 1,
          };
        })
      : [];

    return {
      productId: requireString(item, 'productId', { max: 64 }),
      quantity: requireNumber(item, 'quantity', { min: 1, max: 999 }),
      selections,
      addons,
      notes: optionalString(item, 'notes', { max: 500 }),
    };
  });
}

export function createOrderRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;

  const canViewOrders = security.requirePermission(Permission.ORDERS_VIEW);
  const canCreateOrders = security.requirePermission(Permission.ORDERS_CREATE);
  const canEditOrders = security.requirePermission(Permission.ORDERS_EDIT);
  const canChangeStatus = security.requirePermission(Permission.ORDERS_CHANGE_STATUS);
  const canViewTables = security.requirePermission(Permission.TABLES_VIEW);
  const canManageTables = security.requirePermission(Permission.TABLES_MANAGE);
  const ordersRuntime = security.requireCapability(Capability.ORDERS_RUNTIME);

  /* ------------------------------------------------------------- orders */

  router.post('/orders', async (ctx) => {
    const auth = ctx.state.auth!;
    const body = asObject(ctx.body);

    // A table terminal may only order for its own table. Anyone else has to say
    // which table, and may say "none" for a counter sale.
    const boundTable = auth.terminal
      ? services.tables.getByTerminal(auth.terminal.id)?.id ?? null
      : null;
    const requestedTable = optionalString(body, 'tableId', { max: 32 });

    if (boundTable && requestedTable && requestedTable !== boundTable) {
      throw forbidden('this terminal can only order for its own table');
    }
    const tableId = boundTable ?? requestedTable;

    const order = services.orders.create({
      tableId,
      source: sourceFor(ctx, services),
      actor: auth.actor,
      items: parseItems(body),
      notes: services.settings.get<boolean>('orders.allowCustomerNotes')
        ? optionalString(body, 'notes', { max: 1000 })
        : null,
      guestCount: optionalNumber(body, 'guestCount', { min: 1, max: 200 }),
      clientIp: ctx.ip,
    });

    // Kitchen tickets print automatically when configured; a printer being
    // offline must never fail the order that a diner already placed.
    if (services.settings.get<boolean>('printing.autoPrintKitchenTicket')) {
      const locale = services.settings.profile()?.defaultLocale ?? 'en';
      await services.printing.printKitchenTicket(order, locale).catch(() => undefined);
    }

    return order;
  }, [ordersRuntime, canCreateOrders]);

  router.get('/orders', (ctx) => {
    const statusParam = ctx.query.get('status');
    const statuses = statusParam
      ? statusParam.split(',').filter((value): value is Status =>
          (ORDER_STATUSES as readonly string[]).includes(value))
      : undefined;

    return {
      orders: services.orders.repository.list({
        ...(statuses?.length ? { statuses } : {}),
        ...(ctx.query.get('open') === 'true' ? { openOnly: true } : {}),
        ...(ctx.query.get('tableId') ? { tableId: ctx.query.get('tableId')! } : {}),
        ...(ctx.query.get('businessDay') ? { businessDay: ctx.query.get('businessDay')! } : {}),
        limit: Number(ctx.query.get('limit') ?? 100),
      }),
    };
  }, [canViewOrders]);

  router.get('/orders/:id', (ctx) => {
    const order = services.orders.repository.get(ctx.params['id']!);
    if (!order) throw notFound('order', ctx.params['id']!);

    return {
      order,
      /** Only the transitions this session is actually allowed to perform. */
      availableTransitions: nextStatuses(order.status).filter((transition) =>
        grants(ctx.state.auth!.permissions, transition.permission)),
      bill: services.payments.billFor(order.id),
    };
  }, [canViewOrders]);

  /** The audit trail for one order — the §19 timeline. */
  router.get('/orders/:id/timeline', (ctx) => ({
    events: services.audit.orderTimeline(ctx.params['id']!),
  }), [canViewOrders]);

  router.post('/orders/:id/status', (ctx) => {
    const body = asObject(ctx.body);
    return services.orders.changeStatus({
      orderId: ctx.params['id']!,
      next: requireEnum<Status>(body, 'status', ORDER_STATUSES),
      actor: ctx.state.auth!.actor,
      permissions: ctx.state.auth!.permissions,
      reason: optionalString(body, 'reason', { max: 300 }),
      clientIp: ctx.ip,
    });
  }, [ordersRuntime, canChangeStatus]);

  router.post('/orders/:id/items', async (ctx) => {
    const order = services.orders.addItems({
      orderId: ctx.params['id']!,
      items: parseItems(asObject(ctx.body)),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });

    if (services.settings.get<boolean>('printing.autoPrintKitchenTicket')) {
      const locale = services.settings.profile()?.defaultLocale ?? 'en';
      await services.printing.printKitchenTicket(order, locale).catch(() => undefined);
    }
    return order;
  }, [ordersRuntime, canEditOrders]);

  router.delete('/orders/:id/items/:itemId', (ctx) =>
    services.orders.removeItem({
      orderId: ctx.params['id']!,
      itemId: ctx.params['itemId']!,
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    }), [ordersRuntime, canEditOrders]);

  router.post('/orders/:id/discount', (ctx) => {
    const body = asObject(ctx.body);
    return services.orders.applyDiscount({
      orderId: ctx.params['id']!,
      discountMinor: requireNumber(body, 'discountMinor', { min: 0, max: 100_000_000 }),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [ordersRuntime, security.requireUser(Permission.ORDERS_EDIT)]);

  /**
   * A diner cancelling their own order, within the grace window the restaurant
   * configures. Outside the window they have to ask a waiter, which is the
   * behaviour a kitchen needs.
   */
  router.post('/orders/:id/cancel-by-customer', (ctx) => {
    const auth = ctx.state.auth!;
    if (auth.actor.kind !== ActorKind.CUSTOMER) {
      throw forbidden('this route is for table terminals');
    }
    const order = services.orders.repository.get(ctx.params['id']!);
    if (!order) throw notFound('order', ctx.params['id']!);

    const boundTable = auth.terminal
      ? services.tables.getByTerminal(auth.terminal.id)?.id ?? null
      : null;
    if (!boundTable || order.tableId !== boundTable) {
      throw forbidden('this order belongs to another table');
    }

    const windowSeconds = services.settings.get<number>('orders.customerMayCancelWithinSeconds');
    const ageSeconds = (Date.now() - new Date(order.createdAt).getTime()) / 1000;
    if (ageSeconds > windowSeconds) {
      throw conflict('this order can no longer be cancelled from the table; please ask a waiter', {
        windowSeconds,
      });
    }

    return services.orders.changeStatus({
      orderId: order.id,
      next: OrderStatus.CANCELLED,
      actor: auth.actor,
      // The diner holds `orders.create`, not `orders.cancel`; the restaurant's
      // own grace-window policy is the authority for this one transition.
      permissions: [...auth.permissions, Permission.ORDERS_CANCEL],
      reason: 'cancelled by the diner within the grace window',
      clientIp: ctx.ip,
    });
  }, [ordersRuntime]);

  /* ------------------------------------------------------- station views */

  /** Kitchen display feed (spec §17). */
  router.get('/kitchen/queue', (ctx) => {
    const locale = ctx.query.get('locale') ?? services.settings.profile()?.defaultLocale ?? 'en';
    return {
      queue: services.orders.kitchenQueue(KITCHEN_QUEUE_STATUSES, locale),
      settings: {
        groupByStation: services.settings.get<boolean>('kitchen.groupByStation'),
        showSourceBadge: services.settings.get<boolean>('kitchen.showSourceBadge'),
        urgentAfterMinutes: services.settings.get<number>('kitchen.urgentAfterMinutes'),
      },
    };
  }, [security.requireCapability(Capability.KITCHEN_RUNTIME),
      security.requirePermission(Permission.KITCHEN_VIEW)]);

  /** Cashier working set: open orders with their outstanding balances. */
  router.get('/cashier/orders', () => {
    const open = services.orders.repository.list({ openOnly: true, limit: 200 });
    return {
      orders: open.map((order) => ({
        order,
        bill: services.payments.billFor(order.id),
      })),
    };
  }, [security.requireCapability(Capability.CASHIER_RUNTIME),
      security.requirePermission(Permission.CASHIER_VIEW)]);

  /** Waiter floor view: every table with its status and open orders (spec §12). */
  router.get('/waiter/tables', () => {
    const tables = services.tables.list();
    return {
      tables: tables.map((table) => ({
        id: table.id,
        label: table.label,
        seats: table.seats,
        zone: table.zone,
        status: table.status,
        openOrders: services.orders.repository.openOrdersForTable(table.id),
      })),
    };
  }, [security.requireCapability(Capability.WAITER_RUNTIME),
      security.requirePermission(Permission.WAITER_VIEW)]);

  /* ------------------------------------------------------------- tables */

  router.get('/tables', () => {
    const tables = services.tables.list();
    return {
      tables: tables.map((table) => {
        const terminal = services.terminalRepository.get(table.terminal_id);
        const openOrders = services.orders.repository.openOrdersForTable(table.id);
        return {
          id: table.id,
          label: table.label,
          seats: table.seats,
          zone: table.zone,
          status: table.status,
          terminalId: table.terminal_id,
          qrUrl: terminal ? services.terminals.qrUrlFor(terminal) : null,
          activeOrderIds: openOrders.map((order) => order.id),
          sortOrder: table.sort_order,
          createdAt: table.created_at,
        };
      }),
    };
  }, [canViewTables]);

  router.post('/tables', (ctx) => {
    const body = asObject(ctx.body);
    return services.terminals.createTable({
      label: requireString(body, 'label', { max: 24 }),
      seats: optionalNumber(body, 'seats', { min: 1, max: 100 }) ?? 4,
      zone: optionalString(body, 'zone', { max: 60 }),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [canManageTables]);

  /** Bulk provisioning: "Table 01" through "Table 20" in one action. */
  router.post('/tables/bulk', (ctx) => {
    const body = asObject(ctx.body);
    return services.terminals.createTableRange({
      prefix: optionalString(body, 'prefix', { max: 12, trim: false }) ?? 'Table ',
      from: requireNumber(body, 'from', { min: 1, max: 9999 }),
      to: requireNumber(body, 'to', { min: 1, max: 9999 }),
      seats: optionalNumber(body, 'seats', { min: 1, max: 100 }) ?? 4,
      zone: optionalString(body, 'zone', { max: 60 }),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [canManageTables]);

  router.patch('/tables/:id', (ctx) => {
    const id = ctx.params['id']!;
    if (!services.tables.exists(id)) throw notFound('table', id);
    const body = asObject(ctx.body);

    services.tables.update(id, {
      ...(body['label'] !== undefined ? { label: requireString(body, 'label', { max: 24 }) } : {}),
      ...(body['seats'] !== undefined
        ? { seats: requireNumber(body, 'seats', { min: 1, max: 100 }) } : {}),
      ...(body['zone'] !== undefined ? { zone: optionalString(body, 'zone', { max: 60 }) } : {}),
      ...(body['sortOrder'] !== undefined
        ? { sortOrder: requireNumber(body, 'sortOrder', { min: 0, max: 9999 }) } : {}),
    });
    return services.tables.get(id);
  }, [canManageTables]);

  router.delete('/tables/:id', (ctx) => {
    const id = ctx.params['id']!;
    const table = services.tables.get(id);
    if (!table) throw notFound('table', id);

    // Removing a table with food still owed to it would strand those orders.
    const open = services.orders.repository.openOrdersForTable(id);
    if (open.length > 0) {
      throw conflict('this table still has open orders', { openOrders: open.length });
    }

    services.tables.delete(id);
    // The backing terminal goes with it; cascade handles the row, sessions here.
    services.terminalRepository.deleteSessionsForTerminal(table.terminal_id);
    services.terminalRepository.delete(table.terminal_id);

    services.audit.record({
      action: 'table.deleted',
      actor: ctx.state.auth!.actor,
      entityType: 'table',
      entityId: id,
      tableId: id,
      before: { label: table.label },
      clientIp: ctx.ip,
    });
    return { deleted: id };
  }, [canManageTables]);

  return router;
}
