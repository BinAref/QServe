/**
 * Order state machine (spec §18).
 *
 * Every status change in the system goes through `assertTransition`. Nothing
 * writes `orders.status` directly, which is what makes the audit trail in §19
 * trustworthy: an order cannot reach PAID without having passed a transition
 * that recorded who authorised it.
 */

import { OrderStatus } from './enums.js';
import { AppError } from './errors.js';
import { Permission } from './permissions.js';

export interface OrderTransition {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  /** Permission the actor must hold. */
  readonly permission: string;
  /** i18n key for the button/label that performs this transition. */
  readonly labelKey: string;
  /** Transitions that undo progress and therefore deserve a confirmation step. */
  readonly destructive?: boolean;
}

const T = (
  from: OrderStatus,
  to: OrderStatus,
  permission: string,
  labelKey: string,
  destructive = false,
): OrderTransition => ({ from, to, permission, labelKey, destructive });

const S = OrderStatus;
const P = Permission;

export const ORDER_TRANSITIONS: readonly OrderTransition[] = [
  T(S.NEW, S.ACCEPTED, P.ORDERS_CHANGE_STATUS, 'orders.action.accept'),
  T(S.NEW, S.REJECTED, P.ORDERS_CHANGE_STATUS, 'orders.action.reject', true),
  T(S.NEW, S.ON_HOLD, P.ORDERS_CHANGE_STATUS, 'orders.action.hold'),
  T(S.NEW, S.CANCELLED, P.ORDERS_CANCEL, 'orders.action.cancel', true),

  T(S.ACCEPTED, S.PREPARING, P.ORDERS_CHANGE_STATUS, 'orders.action.start_preparing'),
  T(S.ACCEPTED, S.ON_HOLD, P.ORDERS_CHANGE_STATUS, 'orders.action.hold'),
  T(S.ACCEPTED, S.CANCELLED, P.ORDERS_CANCEL, 'orders.action.cancel', true),

  T(S.PREPARING, S.READY, P.ORDERS_CHANGE_STATUS, 'orders.action.mark_ready'),
  T(S.PREPARING, S.ON_HOLD, P.ORDERS_CHANGE_STATUS, 'orders.action.hold'),
  T(S.PREPARING, S.CANCELLED, P.ORDERS_CANCEL, 'orders.action.cancel', true),

  T(S.READY, S.SERVED, P.ORDERS_CHANGE_STATUS, 'orders.action.mark_served'),
  T(S.READY, S.CANCELLED, P.ORDERS_CANCEL, 'orders.action.cancel', true),

  // Paying without a waiter marking "served" is normal at a counter, so SERVED
  // is reachable-but-optional on the way to PAID.
  T(S.SERVED, S.PAID, P.PAYMENTS_CREATE, 'orders.action.mark_paid'),
  T(S.READY, S.PAID, P.PAYMENTS_CREATE, 'orders.action.mark_paid'),
  T(S.SERVED, S.CANCELLED, P.ORDERS_CANCEL, 'orders.action.cancel', true),

  T(S.PAID, S.CLOSED, P.ORDERS_CHANGE_STATUS, 'orders.action.close'),

  T(S.ON_HOLD, S.NEW, P.ORDERS_CHANGE_STATUS, 'orders.action.resume'),
  T(S.ON_HOLD, S.ACCEPTED, P.ORDERS_CHANGE_STATUS, 'orders.action.resume'),
  T(S.ON_HOLD, S.PREPARING, P.ORDERS_CHANGE_STATUS, 'orders.action.resume'),
  T(S.ON_HOLD, S.CANCELLED, P.ORDERS_CANCEL, 'orders.action.cancel', true),
];

const INDEX: ReadonlyMap<string, OrderTransition> = new Map(
  ORDER_TRANSITIONS.map((t) => [`${t.from}>${t.to}`, t]),
);

/**
 * An illegal transition is a client mistake, not a server fault — a kitchen
 * screen that raced another station, or a stale button. It therefore extends
 * `AppError` and answers 409 with a translation key, rather than surfacing as a
 * 500 and an alarming stack trace in the restaurant's log.
 */
export class InvalidOrderTransitionError extends AppError {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super('INVALID_ORDER_TRANSITION', `order cannot move from ${from} to ${to}`, {
      status: 409,
      messageKey: 'orders.error.invalid_transition',
      details: { from, to },
    });
    this.name = 'AppError';
  }
}

export function findTransition(
  from: OrderStatus,
  to: OrderStatus,
): OrderTransition | undefined {
  return INDEX.get(`${from}>${to}`);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return INDEX.has(`${from}>${to}`);
}

/** Throws unless the transition exists. Returns the transition metadata. */
export function assertTransition(from: OrderStatus, to: OrderStatus): OrderTransition {
  const t = findTransition(from, to);
  if (!t) throw new InvalidOrderTransitionError(from, to);
  return t;
}

/** Every status reachable in one step from `from`. Drives terminal UIs. */
export function nextStatuses(from: OrderStatus): readonly OrderTransition[] {
  return ORDER_TRANSITIONS.filter((t) => t.from === from);
}

/**
 * Statuses that keep a table busy. Used to derive `TableStatus` (spec §46) and
 * to stop a table being released while food is still owed to it.
 */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  S.NEW, S.ACCEPTED, S.PREPARING, S.READY, S.SERVED, S.PAID, S.ON_HOLD,
];

/**
 * The kitchen queue: statuses a cooking station cares about. KDS screens
 * subscribe to these and nothing else.
 */
export const KITCHEN_QUEUE_STATUSES: readonly OrderStatus[] = [
  S.NEW, S.ACCEPTED, S.PREPARING, S.READY,
];
