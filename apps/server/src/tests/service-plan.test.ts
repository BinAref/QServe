/**
 * A restaurant is not obliged to buy four screens.
 *
 * One computer on the counter and a QR on each table is a complete restaurant.
 * So is a computer plus a kitchen display and no till. The product has to
 * behave sensibly in every combination rather than assuming the full set and
 * leaving a diner staring at an order nobody can advance.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActorKind, OrderSource, OrderStatus, WILDCARD_PERMISSION, type Actor,
} from '@qserve/shared';
import { OrderDestination } from '../core/service-plan.js';
import {
  createInstallation, seedRestaurant, seedStations, type Installation,
} from './harness.js';

/** A restaurant with exactly these stations, and one table to order from. */
function restaurantWith(stations: readonly string[]): {
  installation: Installation;
  menu: ReturnType<typeof seedRestaurant>;
  tableId: string;
  customer: Actor;
} {
  const installation = createInstallation();
  const menu = seedRestaurant(installation);
  installation.activate('REST-000001');
  installation.services.currencies.seedBase(
    installation.services.settings.profile()!.currency,
  );
  seedStations(installation, stations);

  const table = installation.services.terminals.createTable({
    label: 'Table 01', actor: installation.systemActor, clientIp: null,
  });

  return {
    installation,
    menu,
    tableId: table.tableId,
    customer: {
      kind: ActorKind.CUSTOMER, userId: null, userName: null,
      terminalId: table.terminal.id, terminalName: 'Table 01',
    },
  };
}

const place = (
  context: ReturnType<typeof restaurantWith>,
): ReturnType<Installation['services']['orders']['create']> =>
  context.installation.services.orders.create({
    tableId: context.tableId,
    source: OrderSource.CUSTOMER,
    actor: context.customer,
    items: [{
      productId: context.menu.friesId, quantity: 1, selections: [], addons: [], notes: null,
    }],
    notes: null,
    guestCount: 1,
    clientIp: null,
  });

describe('a restaurant with nothing but the console and the tables', () => {
  let context: ReturnType<typeof restaurantWith>;

  before(() => { context = restaurantWith([]); });
  after(() => context.installation.dispose());

  test('the plan says the owner’s own screen is the restaurant', () => {
    const plan = context.installation.services.servicePlan.current();

    assert.equal(plan.hasCashier, false);
    assert.equal(plan.hasKitchen, false);
    assert.equal(plan.hasWaiter, false);
    assert.equal(plan.ordersGoTo, OrderDestination.CONSOLE);
    assert.equal(plan.autoPreparing, true, 'accepting an order starts it');
    assert.equal(plan.usesReady, false, 'nobody is there to call it ready');
    assert.equal(plan.callWaiterAfterOrder, false, 'there is no waiter to call');
    assert.equal(plan.afterOrderKey, 'orders.placed_console');
  });

  test('accepting an order starts it, in one move', () => {
    const order = place(context);
    assert.equal(order.status, OrderStatus.NEW);

    const accepted = context.installation.services.orders.changeStatus({
      orderId: order.id,
      next: OrderStatus.ACCEPTED,
      actor: context.installation.systemActor,
      permissions: [WILDCARD_PERMISSION],
      clientIp: null,
    });

    // There is no kitchen screen for anyone to press "start cooking" on, so
    // waiting in ACCEPTED would be a diner watching nothing happen.
    assert.equal(accepted.status, OrderStatus.PREPARING);
  });

  test('the log says it was the missing kitchen, not a person', () => {
    const entries = context.installation.services.audit
      .query({ action: 'order.status_changed', limit: 20 });

    const automatic = entries.find((entry) =>
      (entry.detail as { reason?: string }).reason?.includes('no kitchen'));
    assert.ok(automatic, 'the reason is recorded');
    assert.equal((automatic!.after as { status?: string }).status, OrderStatus.PREPARING);
  });
});

describe('a restaurant with a kitchen but no till', () => {
  let context: ReturnType<typeof restaurantWith>;

  before(() => { context = restaurantWith(['KITCHEN']); });
  after(() => context.installation.dispose());

  test('orders go to the kitchen, and the two steps stay separate', () => {
    const plan = context.installation.services.servicePlan.current();
    assert.equal(plan.ordersGoTo, OrderDestination.KITCHEN);
    assert.equal(plan.autoPreparing, false);
    assert.equal(plan.usesReady, true);

    const order = place(context);
    const accepted = context.installation.services.orders.changeStatus({
      orderId: order.id, next: OrderStatus.ACCEPTED,
      actor: context.installation.systemActor,
      permissions: [WILDCARD_PERMISSION], clientIp: null,
    });
    assert.equal(accepted.status, OrderStatus.ACCEPTED, 'a cook decides when it starts');
  });
});

describe('a restaurant with a waiter but no till', () => {
  let context: ReturnType<typeof restaurantWith>;

  before(() => { context = restaurantWith(['WAITER']); });
  after(() => context.installation.dispose());

  test('the diner is told to catch a waiter', () => {
    const plan = context.installation.services.servicePlan.current();

    assert.equal(plan.ordersGoTo, OrderDestination.WAITER);
    assert.equal(plan.callWaiterAfterOrder, true);
    assert.equal(plan.afterOrderKey, 'orders.placed_call_waiter');
    // Still no kitchen, so accepting still starts it.
    assert.equal(plan.autoPreparing, true);
  });
});

describe('a restaurant with a till', () => {
  let context: ReturnType<typeof restaurantWith>;

  before(() => { context = restaurantWith(['CASHIER', 'WAITER']); });
  after(() => context.installation.dispose());

  test('the till takes the order, so nobody is asked to fetch anyone', () => {
    const plan = context.installation.services.servicePlan.current();

    assert.equal(plan.ordersGoTo, OrderDestination.CASHIER);
    assert.equal(plan.callWaiterAfterOrder, false, 'the till is watching');
    assert.equal(plan.afterOrderKey, 'orders.placed_cashier');
  });

  test('adding a kitchen changes the flow at once, with no restart', () => {
    seedStations(context.installation, ['KITCHEN']);

    const plan = context.installation.services.servicePlan.current();
    assert.equal(plan.hasKitchen, true);
    assert.equal(plan.autoPreparing, false, 'a cook now decides when it starts');
    assert.equal(plan.usesReady, true);
  });

  test('and removing it changes the flow back', () => {
    const { terminals, terminalRepository, servicePlan } = context.installation.services;
    const kitchen = terminalRepository.list().find((entry) => entry.terminal_type === 'KITCHEN')!;

    terminals.deleteTerminal({
      terminalId: kitchen.id, actor: context.installation.systemActor, clientIp: null,
    });

    assert.equal(servicePlan.current().hasKitchen, false);
    assert.equal(servicePlan.current().autoPreparing, true);
  });
});
