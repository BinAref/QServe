/**
 * Order and payment behaviour: server-side pricing, honest attribution, the
 * state machine, table projection and the audit trail (spec §13–§19, §45–§46).
 */

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActorKind, OrderSource, OrderStatus, PaymentMethod, Permission, TableStatus,
  WILDCARD_PERMISSION, type Actor,
} from '@qserve/shared';
import { createInstallation, seedRestaurant, seedUser, type Installation } from './harness.js';

const ALL: readonly string[] = [WILDCARD_PERMISSION];

describe('orders', () => {
  let installation: Installation;
  let menu: ReturnType<typeof seedRestaurant>;
  let waiter: { id: string; actor: Actor };
  let cashier: { id: string; actor: Actor };
  let tableId: string;
  let customerActor: Actor;

  before(() => {
    installation = createInstallation();
    menu = seedRestaurant(installation);
    installation.activate('REST-000001');

    waiter = seedUser(installation, 'ahmed', 'Ahmed', ['WAITER']);
    cashier = seedUser(installation, 'sara', 'Sara', ['CASHIER']);

    const table = installation.services.terminals.createTable({
      label: 'Table 05', actor: installation.systemActor, clientIp: null,
    });
    tableId = table.tableId;

    // A diner's session is the table's own TABLE terminal — the same row the
    // scanned QR enrols against.
    customerActor = {
      kind: ActorKind.CUSTOMER, userId: null, userName: null,
      terminalId: table.terminal.id, terminalName: 'Table 05',
    };
  });
  after(() => installation.dispose());

  const placeOrder = (over: Partial<Parameters<Installation['services']['orders']['create']>[0]> = {}) =>
    installation.services.orders.create({
      tableId,
      source: OrderSource.CUSTOMER,
      actor: customerActor,
      items: [{
        productId: menu.burgerId, quantity: 2,
        selections: [{ optionId: menu.optionId, choiceId: menu.choiceWellDoneId }],
        addons: [{ addonId: menu.addonId, quantity: 1 }],
        notes: null,
      }],
      notes: null,
      guestCount: null,
      clientIp: null,
      ...over,
    });

  test('prices come from the menu, never from the request', () => {
    const order = placeOrder();
    // 25.00 burger + 2.00 well-done + 3.00 cheese = 30.00, taken twice.
    assert.equal(order.items[0]!.lineTotalMinor, 6_000);
    assert.equal(order.totals.subtotalMinor, 6_000);
    assert.equal(order.totals.totalMinor, 6_000, 'no tax configured in this fixture');
  });

  test('a required option must be answered', () => {
    assert.throws(
      () => placeOrder({
        items: [{ productId: menu.burgerId, quantity: 1, selections: [], addons: [], notes: null }],
      }),
      (error: unknown) => (error as { code: string }).code === 'VALIDATION',
    );
  });

  test('a choice from another option, or an add-on not offered, is rejected', () => {
    assert.throws(() => placeOrder({
      items: [{
        productId: menu.friesId, quantity: 1,
        selections: [{ optionId: menu.optionId, choiceId: menu.choiceMediumId }],
        addons: [], notes: null,
      }],
    }));
    assert.throws(() => placeOrder({
      items: [{
        productId: menu.friesId, quantity: 1, selections: [],
        addons: [{ addonId: menu.addonId, quantity: 1 }], notes: null,
      }],
    }));
  });

  test('an unavailable product cannot be ordered', () => {
    installation.services.menu.updateProduct(menu.friesId, { available: false });
    assert.throws(
      () => placeOrder({
        items: [{ productId: menu.friesId, quantity: 1, selections: [], addons: [], notes: null }],
      }),
      (error: unknown) => (error as { code: string }).code === 'CONFLICT',
    );
    installation.services.menu.updateProduct(menu.friesId, { available: true });
  });

  test('the order records who placed it, and from which station', () => {
    const customerOrder = placeOrder();
    assert.equal(customerOrder.source, OrderSource.CUSTOMER);
    assert.equal(customerOrder.createdBy.kind, ActorKind.CUSTOMER);
    assert.equal(customerOrder.createdBy.terminalName, 'Table 05');
    assert.equal(customerOrder.status, OrderStatus.NEW, 'diner orders await acceptance');

    const waiterOrder = placeOrder({ source: OrderSource.WAITER, actor: waiter.actor });
    assert.equal(waiterOrder.source, OrderSource.WAITER);
    assert.equal(waiterOrder.createdBy.userName, 'Ahmed');
    assert.equal(waiterOrder.status, OrderStatus.ACCEPTED,
      'a waiter has already taken the order, so it goes straight to the kitchen');
  });

  test('item names and prices are captured, so a later menu edit cannot rewrite history', () => {
    const order = placeOrder();
    installation.services.menu.updateProduct(menu.burgerId, {
      priceMinor: 9_900, name: { en: 'Renamed Burger' },
    });

    const stored = installation.services.orderRepository.get(order.id)!;
    assert.equal(stored.items[0]!.name['en'], 'Burger');
    assert.equal(stored.items[0]!.unitPriceMinor, 2_500);
    assert.equal(stored.totals.totalMinor, 6_000);

    installation.services.menu.updateProduct(menu.burgerId, {
      priceMinor: 2_500, name: { en: 'Burger' },
    });
  });

  test('status changes obey the state machine and the actor’s permissions', () => {
    const order = placeOrder();
    const { orders } = installation.services;

    assert.throws(() => orders.changeStatus({
      orderId: order.id, next: OrderStatus.READY,
      actor: waiter.actor, permissions: ALL, clientIp: null,
    }), (error: unknown) => (error as { code: string }).code === 'INVALID_ORDER_TRANSITION');

    // A cook without orders.cancel may advance an order but not void it.
    const kitchenOnly = [Permission.ORDERS_CHANGE_STATUS];
    assert.throws(() => orders.changeStatus({
      orderId: order.id, next: OrderStatus.CANCELLED,
      actor: waiter.actor, permissions: kitchenOnly, clientIp: null,
    }), (error: unknown) => (error as { code: string }).code === 'FORBIDDEN');

    const accepted = orders.changeStatus({
      orderId: order.id, next: OrderStatus.ACCEPTED,
      actor: waiter.actor, permissions: kitchenOnly, clientIp: null,
    });
    assert.equal(accepted.status, OrderStatus.ACCEPTED);
  });

  test('serving records the person who served', () => {
    const order = placeOrder({ source: OrderSource.WAITER, actor: waiter.actor });
    const { orders } = installation.services;

    for (const next of [OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.SERVED]) {
      orders.changeStatus({ orderId: order.id, next, actor: waiter.actor, permissions: ALL, clientIp: null });
    }
    const served = installation.services.orderRepository.get(order.id)!;
    assert.equal(served.servedBy?.userName, 'Ahmed');
  });

  test('table status is derived from the orders on it, and never set by hand', () => {
    const fresh = createInstallation();
    try {
      const fixture = seedRestaurant(fresh);
      fresh.activate('REST-000002');
      const { tableId: id } = fresh.services.terminals.createTable({
        label: 'Table 09', actor: fresh.systemActor, clientIp: null,
      });

      assert.equal(fresh.services.tables.get(id)!.status, TableStatus.AVAILABLE);

      const order = fresh.services.orders.create({
        tableId: id, source: OrderSource.CUSTOMER, actor: fresh.systemActor,
        items: [{ productId: fixture.friesId, quantity: 1, selections: [], addons: [], notes: null }],
        notes: null, guestCount: null, clientIp: null,
      });
      assert.equal(fresh.services.tables.get(id)!.status, TableStatus.ORDERING);

      const steps: Record<string, TableStatus> = {
        [OrderStatus.ACCEPTED]: TableStatus.PREPARING,
        [OrderStatus.PREPARING]: TableStatus.PREPARING,
        [OrderStatus.READY]: TableStatus.READY,
        [OrderStatus.SERVED]: TableStatus.WAITING_PAYMENT,
      };
      for (const [next, expected] of Object.entries(steps)) {
        fresh.services.orders.changeStatus({
          orderId: order.id, next: next as OrderStatus,
          actor: fresh.systemActor, permissions: ALL, clientIp: null,
        });
        assert.equal(fresh.services.tables.get(id)!.status, expected, next);
      }

      fresh.services.orders.changeStatus({
        orderId: order.id, next: OrderStatus.PAID,
        actor: fresh.systemActor, permissions: ALL, clientIp: null,
      });
      fresh.services.orders.changeStatus({
        orderId: order.id, next: OrderStatus.CLOSED,
        actor: fresh.systemActor, permissions: ALL, clientIp: null,
      });
      assert.equal(fresh.services.tables.get(id)!.status, TableStatus.AVAILABLE,
        'closing the last order frees the table');
    } finally {
      fresh.dispose();
    }
  });

  test('every step lands in the audit trail with its actor', () => {
    const order = placeOrder({ source: OrderSource.WAITER, actor: waiter.actor });
    installation.services.orders.changeStatus({
      orderId: order.id, next: OrderStatus.PREPARING,
      actor: cashier.actor, permissions: ALL, clientIp: '10.0.0.5',
    });

    const timeline = installation.services.audit.orderTimeline(order.id);
    assert.equal(timeline[0]?.action, 'order.created');
    assert.equal(timeline[0]?.actor.userName, 'Ahmed');

    const change = timeline.find((entry) => entry.action === 'order.status_changed');
    assert.equal(change?.actor.userName, 'Sara');
    assert.deepEqual(change?.before, { status: OrderStatus.ACCEPTED });
    assert.deepEqual(change?.after, { status: OrderStatus.PREPARING });
  });
});

describe('payments', () => {
  let installation: Installation;
  let menu: ReturnType<typeof seedRestaurant>;
  let cashier: { id: string; actor: Actor };

  beforeEach(() => {
    installation = createInstallation();
    menu = seedRestaurant(installation);
    installation.activate('REST-000001');
    cashier = seedUser(installation, 'sara', 'Sara', ['CASHIER']);
  });

  const newOrder = () => installation.services.orders.create({
    tableId: null, source: OrderSource.CASHIER, actor: cashier.actor,
    items: [{ productId: menu.friesId, quantity: 1, selections: [], addons: [], notes: null }],
    notes: null, guestCount: null, clientIp: null,
  });

  test('a payment must be captured by an identified person', () => {
    const order = newOrder();
    assert.throws(
      () => installation.services.payments.capture({
        orderId: order.id, method: PaymentMethod.CASH, amountMinor: 900,
        tenderedMinor: null, reference: null,
        // A cashier *station* with nobody signed in.
        actor: { kind: ActorKind.TERMINAL, userId: null, userName: null,
                 terminalId: 'TERM-X', terminalName: 'Cashier 01' },
        permissions: ALL, clientIp: null,
      }),
      (error: unknown) => (error as { code: string }).code === 'CONFLICT',
    );
    installation.dispose();
  });

  test('split payments settle an order only when fully covered', () => {
    const order = newOrder();
    const { payments } = installation.services;

    const first = payments.capture({
      orderId: order.id, method: PaymentMethod.CASH, amountMinor: 400,
      tenderedMinor: 500, reference: null, actor: cashier.actor, permissions: ALL, clientIp: null,
    });
    assert.equal(first.orderPaid, false);
    assert.equal(first.payment.changeMinor, 100);
    assert.equal(payments.billFor(order.id).outstandingMinor, 500);

    const second = payments.capture({
      orderId: order.id, method: PaymentMethod.CARD, amountMinor: 500,
      tenderedMinor: null, reference: null, actor: cashier.actor, permissions: ALL, clientIp: null,
    });
    assert.equal(second.orderPaid, true);
    assert.equal(payments.billFor(order.id).outstandingMinor, 0);
    installation.dispose();
  });

  test('overpaying is refused, and a settled order cannot be charged again', () => {
    const order = newOrder();
    const { payments } = installation.services;

    assert.throws(() => payments.capture({
      orderId: order.id, method: PaymentMethod.CASH, amountMinor: 1_000,
      tenderedMinor: null, reference: null, actor: cashier.actor, permissions: ALL, clientIp: null,
    }), (error: unknown) => (error as { code: string }).code === 'VALIDATION');

    payments.capture({
      orderId: order.id, method: PaymentMethod.CASH, amountMinor: 900,
      tenderedMinor: null, reference: null, actor: cashier.actor, permissions: ALL, clientIp: null,
    });
    assert.throws(() => payments.capture({
      orderId: order.id, method: PaymentMethod.CASH, amountMinor: 1,
      tenderedMinor: null, reference: null, actor: cashier.actor, permissions: ALL, clientIp: null,
    }), (error: unknown) => (error as { code: string }).code === 'CONFLICT');
    installation.dispose();
  });

  test('the receipt names the cashier who took the money', () => {
    const order = newOrder();
    installation.services.payments.capture({
      orderId: order.id, method: PaymentMethod.CASH, amountMinor: 900,
      tenderedMinor: 1_000, reference: null, actor: cashier.actor, permissions: ALL, clientIp: null,
    });

    // The person is recorded the instant the money is taken, whatever stage the
    // food has reached — that is the accountability the spec demands.
    const paid = installation.services.orderRepository.get(order.id)!;
    assert.equal(paid.paidBy?.userName, 'Sara');
    assert.equal(installation.services.payments.billFor(order.id).outstandingMinor, 0);

    const audit = installation.services.audit.query({ action: 'payment.captured' });
    assert.equal(audit[0]?.actor.userName, 'Sara');
    installation.dispose();
  });

  test('paying while the food is still cooking does not skip the kitchen', () => {
    // Counter service: money now, food later. The order must stay in the
    // kitchen queue and reach PAID by itself once it legally can.
    const order = newOrder();
    const { orders, payments, orderRepository } = installation.services;

    orders.changeStatus({ orderId: order.id, next: OrderStatus.PREPARING,
      actor: cashier.actor, permissions: ALL, clientIp: null });

    const captured = payments.capture({
      orderId: order.id, method: PaymentMethod.CASH, amountMinor: 900,
      tenderedMinor: null, reference: null, actor: cashier.actor, permissions: ALL, clientIp: null,
    });
    assert.equal(captured.orderPaid, true, 'the bill is settled');
    assert.equal(orderRepository.get(order.id)!.status, OrderStatus.PREPARING,
      'but the food is still being cooked');

    orders.changeStatus({ orderId: order.id, next: OrderStatus.READY,
      actor: cashier.actor, permissions: ALL, clientIp: null });
    assert.equal(orderRepository.get(order.id)!.status, OrderStatus.PAID,
      'a settled order advances to PAID as soon as that is a legal step');
    installation.dispose();
  });

  test('a refund is recorded rather than erasing the payment', () => {
    const order = newOrder();
    const { payments } = installation.services;
    const captured = payments.capture({
      orderId: order.id, method: PaymentMethod.CASH, amountMinor: 900,
      tenderedMinor: null, reference: null, actor: cashier.actor, permissions: ALL, clientIp: null,
    });

    const refunded = payments.refund({
      paymentId: captured.payment.id, reason: 'wrong order',
      actor: cashier.actor, clientIp: null,
    });
    assert.equal(refunded.status, 'REFUNDED');
    assert.equal(payments.billFor(order.id).payments.length, 1, 'history is kept, not deleted');

    const audit = installation.services.audit.query({ action: 'payment.refunded' });
    assert.equal(audit[0]?.detail['reason'], 'wrong order');
    installation.dispose();
  });
});
