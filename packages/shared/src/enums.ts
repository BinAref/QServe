/** Closed vocabularies shared by the server, the terminals and the license server. */

/**
 * Operating mode of an installation (spec §2). There is deliberately no "demo":
 * a restaurant builds its *real* menu in SETUP and keeps it after activation.
 */
export const RestaurantMode = {
  /** Pre-activation. Real data, real menu — but no LAN server and no live service. */
  SETUP: 'SETUP',
  /** Licence verified and bound to this device. Full restaurant operation. */
  OPERATIONAL: 'OPERATIONAL',
} as const;
export type RestaurantMode = (typeof RestaurantMode)[keyof typeof RestaurantMode];

/** Who caused an order to exist (spec §13, §45). Persisted, not merely displayed. */
export const OrderSource = {
  CUSTOMER: 'CUSTOMER',
  WAITER: 'WAITER',
  CASHIER: 'CASHIER',
  MANAGER: 'MANAGER',
  INTEGRATION: 'INTEGRATION',
} as const;
export type OrderSource = (typeof OrderSource)[keyof typeof OrderSource];

export const ORDER_SOURCES = Object.values(OrderSource);

/** Order lifecycle (spec §18). Transitions are governed by the state machine. */
export const OrderStatus = {
  NEW: 'NEW',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  SERVED: 'SERVED',
  PAID: 'PAID',
  CLOSED: 'CLOSED',
  ON_HOLD: 'ON_HOLD',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_STATUSES = Object.values(OrderStatus);

/** Statuses after which an order no longer occupies a table. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CLOSED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
];

export const isTerminalOrderStatus = (s: OrderStatus): boolean =>
  TERMINAL_ORDER_STATUSES.includes(s);

/** Table lifecycle (spec §46), derived from the orders currently attached to it. */
export const TableStatus = {
  AVAILABLE: 'AVAILABLE',
  OCCUPIED: 'OCCUPIED',
  ORDERING: 'ORDERING',
  PREPARING: 'PREPARING',
  READY: 'READY',
  WAITING_PAYMENT: 'WAITING_PAYMENT',
  CLOSED: 'CLOSED',
} as const;
export type TableStatus = (typeof TableStatus)[keyof typeof TableStatus];

/**
 * Terminal kinds (spec §24). New kinds are added here and become usable without
 * touching routing, permissions or the QR pipeline — see docs/EXTENDING.md.
 */
export const TerminalType = {
  TABLE: 'TABLE',
  KITCHEN: 'KITCHEN',
  CASHIER: 'CASHIER',
  WAITER: 'WAITER',
  BAR: 'BAR',
  MANAGER: 'MANAGER',
  KDS: 'KDS',
  PRINTER: 'PRINTER',
} as const;
export type TerminalType = (typeof TerminalType)[keyof typeof TerminalType];

export const TERMINAL_TYPES = Object.values(TerminalType);

export const TerminalStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type TerminalStatus = (typeof TerminalStatus)[keyof typeof TerminalStatus];

/** License lifecycle on the central server (spec §27). */
export const LicenseStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  DEACTIVATED: 'DEACTIVATED',
  TRANSFERRED: 'TRANSFERRED',
  REVOKED: 'REVOKED',
} as const;
export type LicenseStatus = (typeof LicenseStatus)[keyof typeof LicenseStatus];

/** Only perpetual licences exist today; the field exists so pricing can grow. */
export const LicenseType = { PERPETUAL: 'PERPETUAL' } as const;
export type LicenseType = (typeof LicenseType)[keyof typeof LicenseType];

export const PaymentMethod = {
  CASH: 'CASH',
  CARD: 'CARD',
  TRANSFER: 'TRANSFER',
  OTHER: 'OTHER',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PaymentStatus = {
  PENDING: 'PENDING',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Which actor performed an audited action (spec §19). */
export const ActorKind = {
  USER: 'USER',
  TERMINAL: 'TERMINAL',
  CUSTOMER: 'CUSTOMER',
  SYSTEM: 'SYSTEM',
  DEVELOPER: 'DEVELOPER',
} as const;
export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];

export const TextDirection = { LTR: 'ltr', RTL: 'rtl' } as const;
export type TextDirection = (typeof TextDirection)[keyof typeof TextDirection];

/** Printer transports the printing module knows how to drive. */
export const PrinterTransport = {
  /** Raw ESC/POS over TCP — the common network thermal printer. */
  NETWORK: 'NETWORK',
  /** Rendered as HTML and pushed to a browser terminal that owns a printer. */
  BROWSER: 'BROWSER',
  /** Written to a spool directory; a local print watcher picks it up. */
  FILE: 'FILE',
} as const;
export type PrinterTransport = (typeof PrinterTransport)[keyof typeof PrinterTransport];

/** What kind of document a printer is allowed to receive (spec §36). */
export const PrintDocumentType = {
  KITCHEN_TICKET: 'KITCHEN_TICKET',
  RECEIPT: 'RECEIPT',
  BAR_TICKET: 'BAR_TICKET',
  REPORT: 'REPORT',
} as const;
export type PrintDocumentType = (typeof PrintDocumentType)[keyof typeof PrintDocumentType];
