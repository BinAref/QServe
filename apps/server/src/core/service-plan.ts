/**
 * What this restaurant actually has, and what that means for an order.
 *
 * A restaurant is not obliged to buy four screens. One computer on the counter
 * and a QR on each table is a complete restaurant; so is a computer plus a
 * kitchen display and no till; so is every other combination. The product has
 * to behave sensibly in all of them rather than assuming the full set and
 * leaving a diner staring at an order nobody can advance.
 *
 * So the flow is derived from the stations that exist, not assumed:
 *
 *   no kitchen      accepting an order means it is being made — it goes
 *                   straight to PREPARING rather than waiting for a screen
 *                   nobody installed to say so.
 *   no till         the order still lands, and the diner is told to catch a
 *                   waiter — or, if there is no waiter either, that it went to
 *                   the counter, which is where the owner is standing.
 *   nothing at all  the console is the restaurant. Every order appears there
 *                   and is advanced there.
 *
 * The plan is recomputed whenever terminals change, and travels in
 * `/api/system`, so every screen adapts without being told separately.
 */

import { TerminalStatus, TerminalType } from '@qserve/shared';
import type { TerminalRepository } from './repositories/terminals.js';

/** Where a new order goes, from the diner's point of view. */
export const OrderDestination = {
  CASHIER: 'CASHIER',
  KITCHEN: 'KITCHEN',
  WAITER: 'WAITER',
  /** Nobody has a station: the owner's own screen is the restaurant. */
  CONSOLE: 'CONSOLE',
} as const;
export type OrderDestination = (typeof OrderDestination)[keyof typeof OrderDestination];

export interface ServicePlan {
  readonly hasCashier: boolean;
  readonly hasKitchen: boolean;
  readonly hasWaiter: boolean;
  readonly hasTables: boolean;
  /** Who a new order lands with. */
  readonly ordersGoTo: OrderDestination;
  /**
   * With no kitchen, accepting an order *is* starting it: there is no screen
   * for a cook to press, so PREPARING follows ACCEPTED by itself.
   */
  readonly autoPreparing: boolean;
  /**
   * READY means "a cook has finished and somebody should carry it". Without a
   * kitchen nobody says that, so the step is still legal but never expected.
   */
  readonly usesReady: boolean;
  /** Tell the diner to catch a waiter, because no till will see this. */
  readonly callWaiterAfterOrder: boolean;
  /** A translation key for what the diner is told after ordering. */
  readonly afterOrderKey: string;
}

const KITCHEN_TYPES: readonly string[] = [
  TerminalType.KITCHEN, TerminalType.KDS, TerminalType.BAR,
];
const TILL_TYPES: readonly string[] = [TerminalType.CASHIER];

export class ServicePlanner {
  constructor(private readonly terminals: TerminalRepository) {}

  /**
   * Recomputed on demand rather than cached: provisioning a station has to
   * change the flow at once, and this is three rows out of a table with a
   * handful in it.
   */
  current(): ServicePlan {
    const live = this.terminals.list()
      .filter((terminal) => terminal.status !== TerminalStatus.DISABLED);

    const has = (types: readonly string[]): boolean =>
      live.some((terminal) => types.includes(terminal.terminal_type));

    const hasCashier = has(TILL_TYPES);
    const hasKitchen = has(KITCHEN_TYPES);
    const hasWaiter = has([TerminalType.WAITER]);
    const hasTables = has([TerminalType.TABLE]);

    // In the order a diner's food actually travels: the till takes it, or the
    // kitchen does, or a waiter does — and if none of them exist, the owner.
    const ordersGoTo = hasCashier
      ? OrderDestination.CASHIER
      : hasKitchen
        ? OrderDestination.KITCHEN
        : hasWaiter
          ? OrderDestination.WAITER
          : OrderDestination.CONSOLE;

    // Nobody is watching a till, so somebody has to be fetched.
    const callWaiterAfterOrder = !hasCashier && hasWaiter;

    return {
      hasCashier,
      hasKitchen,
      hasWaiter,
      hasTables,
      ordersGoTo,
      autoPreparing: !hasKitchen,
      usesReady: hasKitchen,
      callWaiterAfterOrder,
      afterOrderKey: callWaiterAfterOrder
        ? 'orders.placed_call_waiter'
        : `orders.placed_${ordersGoTo.toLowerCase()}`,
    };
  }
}
