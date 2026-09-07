/**
 * Browser-side mirror of the closed vocabularies in `@qserve/shared`.
 *
 * The terminals are plain ES modules with no bundler, so they cannot import the
 * TypeScript package directly. Rather than let the two drift silently, a test
 * (`apps/server/src/tests/web-constants.test.ts`) asserts that every constant
 * here matches the authoritative definition exactly, and fails the build if a
 * new order status or sound event is added on one side only.
 */

export const SoundEvent = {
  NEW_ORDER: 'new_order',
  ORDER_READY: 'order_ready',
  ORDER_URGENT: 'order_urgent',
  ORDER_CANCELLED: 'order_cancelled',
  PAYMENT_SUCCESS: 'payment_success',
  PAYMENT_FAILED: 'payment_failed',
  NOTIFICATION: 'notification',
  ERROR: 'error',
  WAITER_CALLED: 'waiter_called',
  BILL_REQUESTED: 'bill_requested',
  HELP_NEEDED: 'help_needed',
  PRINT_FAILED: 'print_failed',
};

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
  NOTIFICATION: 'notification',
};

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
};

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
};

export const OrderSource = {
  CUSTOMER: 'CUSTOMER',
  WAITER: 'WAITER',
  CASHIER: 'CASHIER',
  MANAGER: 'MANAGER',
  INTEGRATION: 'INTEGRATION',
};

export const TableStatus = {
  AVAILABLE: 'AVAILABLE',
  OCCUPIED: 'OCCUPIED',
  ORDERING: 'ORDERING',
  PREPARING: 'PREPARING',
  READY: 'READY',
  WAITING_PAYMENT: 'WAITING_PAYMENT',
  CLOSED: 'CLOSED',
};

/** What one station tells another. Mirrors NotificationKind in @qserve/shared. */
export const NotificationKind = {
  WAITER_CALLED: 'WAITER_CALLED',
  BILL_REQUESTED: 'BILL_REQUESTED',
  ORDER_READY: 'ORDER_READY',
  ORDER_ACCEPTED: 'ORDER_ACCEPTED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_RUSHED: 'ORDER_RUSHED',
  ORDER_PLACED: 'ORDER_PLACED',
  ITEM_UNAVAILABLE: 'ITEM_UNAVAILABLE',
  PAYMENT_TAKEN: 'PAYMENT_TAKEN',
  PRINT_FAILED: 'PRINT_FAILED',
  BROADCAST: 'BROADCAST',
  HELP_NEEDED: 'HELP_NEEDED',
};

export const NotificationUrgency = {
  INFO: 'INFO',
  ACTION: 'ACTION',
  URGENT: 'URGENT',
};

/**
 * Which sound answers which notice. A notice with no entry here is shown but
 * not heard, which is the right default: most of them are information.
 */
export const NOTIFICATION_SOUND = {
  WAITER_CALLED: 'waiter_called',
  BILL_REQUESTED: 'bill_requested',
  ORDER_READY: 'order_ready',
  ORDER_PLACED: 'new_order',
  ORDER_REJECTED: 'order_cancelled',
  ORDER_RUSHED: 'order_urgent',
  PRINT_FAILED: 'print_failed',
  HELP_NEEDED: 'help_needed',
  BROADCAST: 'notification',
  ITEM_UNAVAILABLE: 'notification',
};

export const TerminalType = {
  TABLE: 'TABLE',
  KITCHEN: 'KITCHEN',
  CASHIER: 'CASHIER',
  WAITER: 'WAITER',
  BAR: 'BAR',
  MANAGER: 'MANAGER',
  KDS: 'KDS',
  PRINTER: 'PRINTER',
};

export const PaymentMethod = {
  CASH: 'CASH',
  CARD: 'CARD',
  TRANSFER: 'TRANSFER',
  OTHER: 'OTHER',
};

export const PrintDocumentType = {
  KITCHEN_TICKET: 'KITCHEN_TICKET',
  RECEIPT: 'RECEIPT',
  BAR_TICKET: 'BAR_TICKET',
  REPORT: 'REPORT',
};

export const PrinterTransport = {
  NETWORK: 'NETWORK',
  BROWSER: 'BROWSER',
  FILE: 'FILE',
};

export const Capability = {
  MENU_AUTHORING: 'menu.authoring',
  BRANDING: 'branding',
  MENU_PREVIEW: 'menu.preview',
  BACKUP: 'backup',
  TABLES_PROVISION: 'tables.provision',
  TERMINALS_PROVISION: 'terminals.provision',
  LAN_SERVER: 'server.lan',
  ORDERS_RUNTIME: 'orders.runtime',
  KITCHEN_RUNTIME: 'kitchen.runtime',
  CASHIER_RUNTIME: 'cashier.runtime',
  WAITER_RUNTIME: 'waiter.runtime',
  PRINTING_RUNTIME: 'printing.runtime',
  REPORTS_RUNTIME: 'reports.runtime',
};

export const Permission = {
  ORDERS_VIEW: 'orders.view',
  ORDERS_CREATE: 'orders.create',
  ORDERS_EDIT: 'orders.edit',
  ORDERS_CANCEL: 'orders.cancel',
  ORDERS_CHANGE_STATUS: 'orders.change_status',
  TABLES_VIEW: 'tables.view',
  TABLES_MANAGE: 'tables.manage',
  MENU_VIEW: 'menu.view',
  MENU_MANAGE: 'menu.manage',
  PAYMENTS_VIEW: 'payments.view',
  PAYMENTS_CREATE: 'payments.create',
  PAYMENTS_REFUND: 'payments.refund',
  REPORTS_VIEW: 'reports.view',
  PRINTING_USE: 'printing.use',
  PRINTING_MANAGE: 'printing.manage',
  KITCHEN_VIEW: 'kitchen.view',
  KITCHEN_MANAGE: 'kitchen.manage',
  CASHIER_VIEW: 'cashier.view',
  CASHIER_MANAGE: 'cashier.manage',
  WAITER_VIEW: 'waiter.view',
  WAITER_MANAGE: 'waiter.manage',
  TERMINALS_VIEW: 'terminals.view',
  TERMINALS_MANAGE: 'terminals.manage',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  SETTINGS_MANAGE: 'settings.manage',
  LICENSE_MANAGE: 'license.manage',
  BACKUP_MANAGE: 'backup.manage',
  AUDIT_VIEW: 'audit.view',
};

/** True when `granted` covers `required`, mirroring the server's `grants()`. */
export function grants(granted, required) {
  for (const entry of granted ?? []) {
    if (entry === '*' || entry === required) return true;
    if (entry.endsWith('.*') && required.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}
