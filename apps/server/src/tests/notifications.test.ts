/**
 * Notifications between stations.
 *
 * The property worth testing is not that a row is written — it is *who is
 * told*. A kitchen screen interrupted by bill requests is a kitchen screen
 * somebody mutes, and a muted screen loses food.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActorKind, NotificationKind, NotificationUrgency, OrderSource, OrderStatus,
  Permission, TerminalType, WILDCARD_PERMISSION, type Actor,
} from '@qserve/shared';
import { createInstallation, seedRestaurant, seedStations, seedUser, type Installation } from './harness.js';

describe('notifications', () => {
  let installation: Installation;
  let menu: ReturnType<typeof seedRestaurant>;
  let tableId: string;
  let customer: Actor;
  let cook: { id: string; actor: Actor };

  before(() => {
    installation = createInstallation();
    menu = seedRestaurant(installation);
    installation.activate('REST-000001');
    // These tests are about the full chain, so the full chain exists.
    seedStations(installation, ['KITCHEN']);
    installation.services.currencies.seedBase(
      installation.services.settings.profile()!.currency,
    );

    cook = seedUser(installation, 'yusuf', 'Yusuf', ['KITCHEN']);

    const table = installation.services.terminals.createTable({
      label: 'Table 09', actor: installation.systemActor, clientIp: null,
    });
    tableId = table.tableId;
    customer = {
      kind: ActorKind.CUSTOMER, userId: null, userName: null,
      terminalId: table.terminal.id, terminalName: 'Table 09',
    };
  });
  after(() => installation.dispose());

  const place = (): string => installation.services.orders.create({
    tableId,
    source: OrderSource.CUSTOMER,
    actor: customer,
    items: [{
      productId: menu.friesId, quantity: 1, selections: [], addons: [], notes: null,
    }],
    notes: null,
    guestCount: 2,
    clientIp: null,
  }).id;

  test('a new order tells the kitchen and nobody else', () => {
    const { notifications } = installation.services;
    place();

    const forKitchen = notifications.forTerminal({ terminalType: TerminalType.KITCHEN });
    const placed = forKitchen.find((n) => n.kind === NotificationKind.ORDER_PLACED);
    assert.ok(placed, 'the kitchen was told');
    assert.equal(placed!.tableLabel, 'Table 09');
    assert.equal(placed!.params['order'], 1);

    // A diner's own phone is never in an audience.
    const forTable = notifications.forTerminal({ terminalType: TerminalType.TABLE });
    assert.equal(forTable.length, 0, 'the table hears nothing');
  });

  test('food coming up reaches the floor, urgently', () => {
    const { notifications, orders } = installation.services;
    const orderId = place();

    for (const next of [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY]) {
      orders.changeStatus({
        orderId, next, actor: cook.actor,
        permissions: [WILDCARD_PERMISSION],
        clientIp: null,
      });
    }

    const waiter = notifications.forTerminal({ terminalType: TerminalType.WAITER });
    const ready = waiter.find((n) => n.kind === NotificationKind.ORDER_READY);

    assert.ok(ready, 'the floor was told the food is up');
    assert.equal(ready!.urgency, NotificationUrgency.URGENT, 'and it keeps asking');
    assert.equal(ready!.from.userName, 'Yusuf', 'with who said so');

    // The kitchen does not need telling about its own work.
    const kitchen = notifications.forTerminal({ terminalType: TerminalType.KITCHEN });
    assert.equal(kitchen.some((n) => n.kind === NotificationKind.ORDER_READY), false);
  });

  test('a table calling reaches the floor and not the pass', () => {
    const { notifications } = installation.services;
    notifications.raise({
      kind: NotificationKind.WAITER_CALLED,
      messageKey: 'notify.waiter_called',
      actor: customer,
      tableId,
      tableLabel: 'Table 09',
    });

    const waiter = notifications.forTerminal({ terminalType: TerminalType.WAITER });
    assert.ok(waiter.some((n) => n.kind === NotificationKind.WAITER_CALLED));

    const kitchen = notifications.forTerminal({ terminalType: TerminalType.KITCHEN });
    assert.equal(kitchen.some((n) => n.kind === NotificationKind.WAITER_CALLED), false);
  });

  test('acknowledging clears it for every station at once', () => {
    const { notifications } = installation.services;
    const open = notifications.forTerminal({ terminalType: TerminalType.WAITER });
    const call = open.find((n) => n.kind === NotificationKind.WAITER_CALLED)!;

    const acknowledged = notifications.acknowledge(call.id, cook.actor)!;
    assert.ok(acknowledged.acknowledgedAt);
    assert.equal(acknowledged.acknowledgedName, 'Yusuf', 'and who heard it is recorded');

    const after = notifications.forTerminal({ terminalType: TerminalType.WAITER });
    assert.equal(after.some((n) => n.id === call.id), false, 'it is gone from the board');

    // Acknowledging twice is not an error, and does not rewrite who heard it.
    const again = notifications.acknowledge(call.id, installation.systemActor)!;
    assert.equal(again.acknowledgedName, 'Yusuf');
  });

  test('a notice narrowed by permission reaches only who can act on it', () => {
    const { notifications } = installation.services;
    notifications.raise({
      kind: NotificationKind.PRINT_FAILED,
      messageKey: 'notify.print_failed',
      params: { printer: 'Pass', error: 'ECONNREFUSED' },
    });

    // A manager terminal held by someone who cannot manage printing is not the
    // right person to tell.
    const withoutPermission = notifications.forTerminal({
      terminalType: TerminalType.MANAGER,
      permissions: [Permission.ORDERS_VIEW],
    });
    assert.equal(withoutPermission.some((n) => n.kind === NotificationKind.PRINT_FAILED), false);

    const withPermission = notifications.forTerminal({
      terminalType: TerminalType.MANAGER,
      permissions: [Permission.PRINTING_MANAGE],
    });
    assert.ok(withPermission.some((n) => n.kind === NotificationKind.PRINT_FAILED));

    // A wildcard covers it, as it covers everything.
    const owner = notifications.forTerminal({
      terminalType: TerminalType.MANAGER,
      permissions: [WILDCARD_PERMISSION],
    });
    assert.ok(owner.some((n) => n.kind === NotificationKind.PRINT_FAILED));
  });

  test('a notice aimed at one station goes only there', () => {
    const { notifications, terminalRepository } = installation.services;
    const [target] = terminalRepository.list();

    notifications.raise({
      kind: NotificationKind.BROADCAST,
      messageKey: 'notify.broadcast',
      body: 'Staff meeting at four',
      toTerminalId: target!.id,
    });

    const mine = notifications.forTerminal({
      terminalType: target!.terminal_type, terminalId: target!.id,
    });
    assert.ok(mine.some((n) => n.body === 'Staff meeting at four'));

    const elsewhere = notifications.forTerminal({
      terminalType: target!.terminal_type, terminalId: 'TERM-SOMEONE-ELSE',
    });
    assert.equal(elsewhere.some((n) => n.body === 'Staff meeting at four'), false);
  });

  test('the board can be cleared, and old ones swept up', () => {
    const { notifications } = installation.services;
    const cleared = notifications.acknowledgeAll(installation.systemActor);
    assert.ok(cleared > 0);
    assert.equal(notifications.forTerminal({ terminalType: TerminalType.WAITER }).length, 0);

    // Nothing is old enough to prune yet — the audit log is the record, this is
    // only the working surface.
    assert.equal(notifications.prune(3), 0);
    assert.ok(notifications.prune(0) > 0);
  });
});
