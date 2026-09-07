/**
 * Notifications (spec §21).
 *
 * Every terminal asks for its own list on connect and then listens; the socket
 * carries the rest. The filtering happens on the server, so a phone that should
 * not see a bill request never receives one rather than receiving it and hiding
 * it.
 */

import {
  asObject, forbidden, grants, NotificationKind, optionalString, Permission,
  requireEnum, requireString, validationError,
} from '@qserve/shared';
import { Router } from '@qserve/http';
import type { Services } from '../../container.js';
import type { AppState } from '../../core/security.js';

/** What a person may raise by hand, as opposed to what the system raises. */
const HAND_RAISED: readonly string[] = [
  NotificationKind.WAITER_CALLED,
  NotificationKind.BILL_REQUESTED,
  NotificationKind.ORDER_RUSHED,
  NotificationKind.ITEM_UNAVAILABLE,
  NotificationKind.HELP_NEEDED,
  NotificationKind.BROADCAST,
];

export function createNotificationRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;

  /** This station's open notices, in the order they arrived. */
  router.get('/notifications', (ctx) => {
    const auth = ctx.state.auth!;
    return {
      notifications: services.notifications.forTerminal({
        terminalType: auth.terminal?.terminal_type ?? null,
        terminalId: auth.terminal?.id ?? null,
        permissions: auth.permissions,
        includeAcknowledged: ctx.query.get('all') === 'true',
        limit: Number(ctx.query.get('limit') ?? 50),
      }),
    };
  });

  /**
   * Raise one by hand.
   *
   * A diner's table may call a waiter and ask for the bill and nothing else —
   * the kind is checked against what this station is for, so a tampered request
   * from a table cannot broadcast to the kitchen.
   */
  router.post('/notifications', (ctx) => {
    const body = asObject(ctx.body);
    const kind = requireEnum(body, 'kind', HAND_RAISED) as NotificationKind;
    const auth = ctx.state.auth!;

    const fromTable = auth.terminal?.terminal_type === 'TABLE';
    if (fromTable && kind !== NotificationKind.WAITER_CALLED
      && kind !== NotificationKind.BILL_REQUESTED) {
      throw validationError('a table can call a waiter or ask for the bill', { field: 'kind' });
    }
    if (kind === NotificationKind.BROADCAST && !grants(auth.permissions, Permission.ORDERS_VIEW)) {
      // Talking to the whole floor is a manager's job, not a diner's.
      throw forbidden(Permission.ORDERS_VIEW);
    }

    const table = auth.terminal?.terminal_type === 'TABLE'
      ? services.tables.getByTerminal(auth.terminal.id)
      : null;

    return services.notifications.raise({
      kind,
      messageKey: `notify.${kind.toLowerCase()}`,
      actor: auth.actor,
      ...(body['orderId'] !== undefined
        ? { orderId: requireString(body, 'orderId', { max: 64 }) } : {}),
      ...(table ? { tableId: table.id, tableLabel: table.label } : {}),
      body: optionalString(body, 'body', { max: 400 }),
      ...(body['params'] !== undefined
        ? { params: asObject(body['params'], 'params') } : {}),
    });
  });

  /** Somebody heard it. Every station drops it at once. */
  router.post('/notifications/:id/ack', (ctx) =>
    services.notifications.acknowledge(ctx.params['id']!, ctx.state.auth!.actor)
    ?? { acknowledged: false });

  router.post('/notifications/ack-all', (ctx) => ({
    acknowledged: services.notifications.acknowledgeAll(ctx.state.auth!.actor),
  }), [security.requireUser()]);

  return router;
}
