/**
 * Payments (spec §14, §15, §43).
 *
 * The rule this module exists to enforce: a payment always names the person who
 * took it. `paid_by_user_id` is not optional and not derived from the request
 * body — it comes from the authenticated user session, which is why the routes
 * that reach here are guarded by `requireUser` and not merely by a permission.
 */

import type { Db } from '@qserve/db';
import { nowIso } from '@qserve/db';
import {
  canTransition, conflict, EventName, newEntityId, NotificationKind, notFound, OrderStatus,
  PaymentMethod, PaymentStatus, validationError,
  type Actor, type Payment, type PaymentMethod as Method,
} from '@qserve/shared';
import type { EventBus } from '../../core/event-bus.js';
import type { AuditRepository } from '../../core/repositories/audit.js';
import type { OrderService } from '../orders/service.js';
import type { OrderRepository } from '../orders/repository.js';
import type { NotifyInput } from '../orders/service.js';

interface PaymentRow {
  id: string; order_id: string; method: Method; status: string;
  amount_minor: number; tendered_minor: number | null; change_minor: number | null;
  reference: string | null;
  captured_by_user_id: string | null; captured_by_user_name: string | null;
  captured_by_terminal_id: string | null; captured_by_terminal_name: string | null;
  captured_at: string | null; created_at: string;
}

export class PaymentRepository {
  constructor(private readonly db: Db) {}

  insert(input: {
    orderId: string; method: Method; status: string; amountMinor: number;
    tenderedMinor: number | null; changeMinor: number | null; reference: string | null;
    actor: Actor; capturedAt: string | null;
  }): Payment {
    const id = newEntityId('PAY');
    this.db
      .prepare(`
        INSERT INTO payments
          (id, order_id, method, status, amount_minor, tendered_minor, change_minor, reference,
           captured_by_user_id, captured_by_user_name,
           captured_by_terminal_id, captured_by_terminal_name, captured_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, input.orderId, input.method, input.status, input.amountMinor,
        input.tenderedMinor, input.changeMinor, input.reference,
        input.actor.userId, input.actor.userName,
        input.actor.terminalId, input.actor.terminalName,
        input.capturedAt, nowIso(),
      );
    return this.get(id)!;
  }

  get(id: string): Payment | null {
    const row = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as
      | PaymentRow
      | undefined;
    return row ? toPayment(row) : null;
  }

  listForOrder(orderId: string): Payment[] {
    return (
      this.db
        .prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at')
        .all(orderId) as PaymentRow[]
    ).map(toPayment);
  }

  setStatus(id: string, status: string): void {
    this.db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, id);
  }

  /** Sum of captured payments, used to decide whether a bill is settled. */
  capturedTotal(orderId: string): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
        WHERE order_id = ? AND status = 'CAPTURED'
      `)
      .get(orderId) as { total: number };
    return row.total;
  }

  takingsByMethod(since: string, until: string): { method: string; count: number; totalMinor: number }[] {
    return (
      this.db
        .prepare(`
          SELECT method, COUNT(*) AS count, COALESCE(SUM(amount_minor), 0) AS total
          FROM payments
          WHERE status = 'CAPTURED' AND captured_at >= ? AND captured_at <= ?
          GROUP BY method ORDER BY total DESC
        `)
        .all(since, until) as { method: string; count: number; total: number }[]
    ).map((row) => ({ method: row.method, count: row.count, totalMinor: row.total }));
  }

  /** Per-cashier takings — the shift reconciliation a manager actually needs. */
  takingsByUser(since: string, until: string): {
    userId: string | null; userName: string | null; count: number; totalMinor: number;
  }[] {
    return (
      this.db
        .prepare(`
          SELECT captured_by_user_id AS user_id, captured_by_user_name AS user_name,
                 COUNT(*) AS count, COALESCE(SUM(amount_minor), 0) AS total
          FROM payments
          WHERE status = 'CAPTURED' AND captured_at >= ? AND captured_at <= ?
          GROUP BY captured_by_user_id, captured_by_user_name
          ORDER BY total DESC
        `)
        .all(since, until) as {
          user_id: string | null; user_name: string | null; count: number; total: number;
        }[]
    ).map((row) => ({
      userId: row.user_id, userName: row.user_name, count: row.count, totalMinor: row.total,
    }));
  }
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.order_id,
    method: row.method,
    status: row.status as Payment['status'],
    amountMinor: row.amount_minor,
    tenderedMinor: row.tendered_minor,
    changeMinor: row.change_minor,
    reference: row.reference,
    capturedBy: row.captured_by_user_id || row.captured_by_terminal_id
      ? {
          kind: 'USER',
          userId: row.captured_by_user_id,
          userName: row.captured_by_user_name,
          terminalId: row.captured_by_terminal_id,
          terminalName: row.captured_by_terminal_name,
        }
      : null,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
  };
}

export interface CaptureInput {
  readonly orderId: string;
  readonly method: Method;
  readonly amountMinor: number;
  readonly tenderedMinor: number | null;
  readonly reference: string | null;
  readonly actor: Actor;
  readonly permissions: readonly string[];
  readonly clientIp: string | null;
}

export class PaymentService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly orders: OrderRepository,
    private readonly orderService: OrderService,
    private readonly audit: AuditRepository,
    private readonly bus: EventBus,
  ) {}

  /** Told about a settled bill, without this module knowing what a notice is. */
  private notify: ((input: NotifyInput) => void) | null = null;

  setNotifier(notify: (input: NotifyInput) => void): void {
    this.notify = notify;
  }

  /**
   * Capture a payment. Partial payments are allowed (split bills); the order
   * only reaches PAID once the captured total covers it.
   */
  capture(input: CaptureInput): { payment: Payment; orderPaid: boolean } {
    const order = this.orders.get(input.orderId);
    if (!order) throw notFound('order', input.orderId);

    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REJECTED) {
      throw conflict('a cancelled order cannot be paid', { status: order.status });
    }
    if (!input.actor.userId) {
      // Belt and braces: the route guard should already have refused this.
      throw conflict('a payment must be captured by an identified user');
    }
    if (input.amountMinor <= 0) {
      throw validationError('payment amount must be positive', { field: 'amountMinor' });
    }

    const alreadyCaptured = this.payments.capturedTotal(input.orderId);
    const outstanding = order.totals.totalMinor - alreadyCaptured;
    if (outstanding <= 0) throw conflict('this order is already fully paid');
    if (input.amountMinor > outstanding) {
      throw validationError('payment exceeds the outstanding balance', {
        field: 'amountMinor', outstandingMinor: outstanding,
      });
    }

    const changeMinor =
      input.method === PaymentMethod.CASH && input.tenderedMinor !== null
        ? Math.max(0, input.tenderedMinor - input.amountMinor)
        : null;

    if (input.method === PaymentMethod.CASH && input.tenderedMinor !== null
        && input.tenderedMinor < input.amountMinor) {
      throw validationError('tendered amount is less than the payment', { field: 'tenderedMinor' });
    }

    const payment = this.payments.insert({
      orderId: input.orderId,
      method: input.method,
      status: PaymentStatus.CAPTURED,
      amountMinor: input.amountMinor,
      tenderedMinor: input.tenderedMinor,
      changeMinor,
      reference: input.reference,
      actor: input.actor,
      capturedAt: nowIso(),
    });

    const fullyPaid = alreadyCaptured + input.amountMinor >= order.totals.totalMinor;

    // Record who took the money regardless of where the food has got to.
    if (fullyPaid) this.orders.setPaidBy(input.orderId, input.actor);

    // Money and food are separate tracks. Paying up front at a counter is
    // ordinary, and it must not shove an order that is still being cooked
    // straight to PAID and out of the kitchen queue. So the order advances only
    // when PAID is a legal next step; otherwise `OrderService` advances it by
    // itself the moment the order reaches such a state.
    const advanced = fullyPaid && canTransition(order.status, OrderStatus.PAID);
    if (advanced) {
      this.orderService.changeStatus({
        orderId: input.orderId,
        next: OrderStatus.PAID,
        actor: input.actor,
        permissions: input.permissions,
        reason: 'payment captured',
        clientIp: input.clientIp,
      });
    }

    this.audit.record({
      action: 'payment.captured',
      actor: input.actor,
      entityType: 'payment',
      entityId: payment.id,
      orderId: input.orderId,
      tableId: order.tableId,
      after: {
        method: payment.method, amountMinor: payment.amountMinor, changeMinor,
      },
      detail: {
        fullyPaid,
        outstandingBeforeMinor: outstanding,
        orderAdvancedToPaid: advanced,
        orderStatusAtCapture: order.status,
      },
      clientIp: input.clientIp,
    });

    this.bus.publish({
      name: EventName.PAYMENT_CAPTURED,
      payload: { payment, orderId: input.orderId, fullyPaid },
      originTerminalId: input.actor.terminalId,
    });

    if (fullyPaid) {
      this.notify?.({
        kind: NotificationKind.PAYMENT_TAKEN,
        messageKey: 'notify.payment_taken',
        params: { order: order.number, table: order.tableLabel ?? '' },
        actor: input.actor,
        orderId: order.id,
        tableId: order.tableId,
        tableLabel: order.tableLabel,
      });
    }

    return { payment, orderPaid: fullyPaid };
  }

  refund(input: {
    paymentId: string; reason: string; actor: Actor; clientIp: string | null;
  }): Payment {
    const payment = this.payments.get(input.paymentId);
    if (!payment) throw notFound('payment', input.paymentId);
    if (payment.status !== PaymentStatus.CAPTURED) {
      throw conflict('only a captured payment can be refunded', { status: payment.status });
    }

    this.payments.setStatus(payment.id, PaymentStatus.REFUNDED);

    this.audit.record({
      action: 'payment.refunded',
      actor: input.actor,
      entityType: 'payment',
      entityId: payment.id,
      orderId: payment.orderId,
      before: { status: payment.status },
      after: { status: PaymentStatus.REFUNDED },
      detail: { reason: input.reason, amountMinor: payment.amountMinor },
      clientIp: input.clientIp,
    });

    const refunded = this.payments.get(payment.id)!;
    this.bus.publish({
      name: EventName.PAYMENT_REFUNDED,
      payload: { payment: refunded, reason: input.reason },
      originTerminalId: input.actor.terminalId,
    });
    return refunded;
  }

  /** What a cashier screen needs for one order: the bill and what is left. */
  billFor(orderId: string): {
    orderId: string; totalMinor: number; capturedMinor: number; outstandingMinor: number;
    payments: Payment[];
  } {
    const order = this.orders.get(orderId);
    if (!order) throw notFound('order', orderId);
    const captured = this.payments.capturedTotal(orderId);
    return {
      orderId,
      totalMinor: order.totals.totalMinor,
      capturedMinor: captured,
      outstandingMinor: Math.max(0, order.totals.totalMinor - captured),
      payments: this.payments.listForOrder(orderId),
    };
  }

  get repository(): PaymentRepository {
    return this.payments;
  }
}
