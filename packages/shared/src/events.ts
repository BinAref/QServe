/**
 * Realtime event catalogue (spec §22).
 *
 * Terminals never poll. The local server owns an in-process event bus; the
 * WebSocket gateway is a thin projection of it onto connected sockets. Every
 * event declares the topic it belongs to and the permission required to receive
 * it, so a kitchen screen physically cannot be sent payment totals.
 */

import { Permission } from './permissions.js';

export const Topic = {
  ORDERS: 'orders',
  TABLES: 'tables',
  KITCHEN: 'kitchen',
  CASHIER: 'cashier',
  WAITER: 'waiter',
  MENU: 'menu',
  PRINTING: 'printing',
  TERMINALS: 'terminals',
  SYSTEM: 'system',
} as const;
export type Topic = (typeof Topic)[keyof typeof Topic];

export const EventName = {
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_ITEMS_CHANGED: 'order.items_changed',

  TABLE_STATUS_CHANGED: 'table.status_changed',
  TABLE_CREATED: 'table.created',
  TABLE_UPDATED: 'table.updated',

  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',

  MENU_UPDATED: 'menu.updated',

  PRINT_JOB_QUEUED: 'print.job_queued',
  PRINT_JOB_RESULT: 'print.job_result',

  TERMINAL_PRESENCE: 'terminal.presence',
  TERMINAL_CREATED: 'terminal.created',
  TERMINAL_UPDATED: 'terminal.updated',

  SYSTEM_MODE_CHANGED: 'system.mode_changed',
  SYSTEM_LICENSE_CHANGED: 'system.license_changed',
  SYSTEM_SETTINGS_CHANGED: 'system.settings_changed',
  /** Somebody is trying to sign in as an account that is already signed in. */
  SYSTEM_LOGIN_REQUESTED: 'system.login_requested',
  /** This session has been ended — by the person who let somebody else in. */
  SYSTEM_SESSION_ENDED: 'system.session_ended',
  /** Server-initiated attention request, e.g. "table 5 is calling a waiter". */
  NOTIFICATION: 'notification',
} as const;
export type EventName = (typeof EventName)[keyof typeof EventName];

export interface EventDescriptor {
  readonly name: EventName;
  readonly topic: Topic;
  /** Null means "any authenticated session on this installation". */
  readonly permission: string | null;
}

const E = EventName;
const P = Permission;

export const EVENT_CATALOGUE: readonly EventDescriptor[] = [
  { name: E.ORDER_CREATED, topic: Topic.ORDERS, permission: P.ORDERS_VIEW },
  { name: E.ORDER_UPDATED, topic: Topic.ORDERS, permission: P.ORDERS_VIEW },
  { name: E.ORDER_STATUS_CHANGED, topic: Topic.ORDERS, permission: P.ORDERS_VIEW },
  { name: E.ORDER_ITEMS_CHANGED, topic: Topic.ORDERS, permission: P.ORDERS_VIEW },

  { name: E.TABLE_STATUS_CHANGED, topic: Topic.TABLES, permission: P.TABLES_VIEW },
  { name: E.TABLE_CREATED, topic: Topic.TABLES, permission: P.TABLES_VIEW },
  { name: E.TABLE_UPDATED, topic: Topic.TABLES, permission: P.TABLES_VIEW },

  { name: E.PAYMENT_CAPTURED, topic: Topic.CASHIER, permission: P.PAYMENTS_VIEW },
  { name: E.PAYMENT_FAILED, topic: Topic.CASHIER, permission: P.PAYMENTS_VIEW },
  { name: E.PAYMENT_REFUNDED, topic: Topic.CASHIER, permission: P.PAYMENTS_VIEW },

  { name: E.MENU_UPDATED, topic: Topic.MENU, permission: P.MENU_VIEW },

  { name: E.PRINT_JOB_QUEUED, topic: Topic.PRINTING, permission: P.PRINTING_USE },
  { name: E.PRINT_JOB_RESULT, topic: Topic.PRINTING, permission: P.PRINTING_USE },

  { name: E.TERMINAL_PRESENCE, topic: Topic.TERMINALS, permission: P.TERMINALS_VIEW },
  { name: E.TERMINAL_CREATED, topic: Topic.TERMINALS, permission: P.TERMINALS_VIEW },
  { name: E.TERMINAL_UPDATED, topic: Topic.TERMINALS, permission: P.TERMINALS_VIEW },

  { name: E.SYSTEM_MODE_CHANGED, topic: Topic.SYSTEM, permission: null },
  { name: E.SYSTEM_LICENSE_CHANGED, topic: Topic.SYSTEM, permission: P.LICENSE_MANAGE },
  { name: E.SYSTEM_SETTINGS_CHANGED, topic: Topic.SYSTEM, permission: null },
  // Both go to every signed-in screen: the one being asked has to see the
  // question, and the one being ended has to find out why.
  { name: E.SYSTEM_LOGIN_REQUESTED, topic: Topic.SYSTEM, permission: null },
  { name: E.SYSTEM_SESSION_ENDED, topic: Topic.SYSTEM, permission: null },
  { name: E.NOTIFICATION, topic: Topic.SYSTEM, permission: null },
];

const CATALOGUE_INDEX: ReadonlyMap<string, EventDescriptor> = new Map(
  EVENT_CATALOGUE.map((d) => [d.name, d]),
);

export const describeEvent = (name: string): EventDescriptor | undefined =>
  CATALOGUE_INDEX.get(name);

/** Envelope pushed over the WebSocket. */
export interface RealtimeEvent<T = unknown> {
  readonly name: EventName;
  readonly topic: Topic;
  /** Server-assigned, monotonic per installation. Lets a client detect gaps. */
  readonly seq: number;
  readonly at: string;
  readonly payload: T;
  /**
   * Terminal that caused the event, when there was one. A terminal can use this
   * to suppress the sound for an action it performed itself.
   */
  readonly originTerminalId?: string;
}

/** Client → server frames. Deliberately tiny: this is not a general RPC channel. */
export type ClientFrame =
  | { readonly type: 'subscribe'; readonly topics: readonly string[] }
  | { readonly type: 'unsubscribe'; readonly topics: readonly string[] }
  | { readonly type: 'ping' }
  /** Silences a repeating alert (spec §21 "continue until acknowledged"). */
  | { readonly type: 'ack'; readonly eventSeq: number };

export type ServerFrame =
  | { readonly type: 'event'; readonly event: RealtimeEvent }
  | { readonly type: 'welcome'; readonly topics: readonly string[]; readonly seq: number }
  | { readonly type: 'pong' }
  | { readonly type: 'error'; readonly code: string; readonly messageKey: string };
