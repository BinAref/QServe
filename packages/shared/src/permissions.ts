/**
 * Permission catalogue (spec §23).
 *
 * These are enforced server-side on every mutating route and on every realtime
 * subscription. Hiding a button in the UI is a convenience, never the control.
 */

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
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export const isPermission = (v: unknown): v is Permission =>
  typeof v === 'string' && PERMISSION_SET.has(v);

/**
 * Wildcard held only by the built-in ADMIN role. Stored as a normal permission
 * row so that `roles.manage` can grant/revoke it like anything else.
 */
export const WILDCARD_PERMISSION = '*';

/**
 * Built-in role keys. A restaurant may add its own and may rename any of these,
 * but cannot delete or re-scope them — the key is what the rest of the product
 * is written against, and the name is what people read.
 */
export const SystemRole = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  CASHIER: 'CASHIER',
  WAITER: 'WAITER',
  KITCHEN: 'KITCHEN',
  CUSTOMER: 'CUSTOMER',
} as const;
export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

const P = Permission;

/**
 * What each built-in role may do. Seeded into `role_permissions` at install and
 * restated at every boot, because these grants are the product's promise rather
 * than a restaurant's setting: a cashier means the same thing everywhere QServe
 * runs, whatever that restaurant calls the person. What a restaurant *does* own
 * is the name, and any role it adds itself.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<SystemRole, readonly string[]>> = {
  [SystemRole.ADMIN]: [WILDCARD_PERMISSION],

  [SystemRole.MANAGER]: [
    P.ORDERS_VIEW, P.ORDERS_CREATE, P.ORDERS_EDIT, P.ORDERS_CANCEL, P.ORDERS_CHANGE_STATUS,
    P.TABLES_VIEW, P.TABLES_MANAGE,
    P.MENU_VIEW, P.MENU_MANAGE,
    P.PAYMENTS_VIEW, P.PAYMENTS_CREATE, P.PAYMENTS_REFUND,
    P.REPORTS_VIEW,
    P.PRINTING_USE, P.PRINTING_MANAGE,
    P.KITCHEN_VIEW, P.KITCHEN_MANAGE,
    P.CASHIER_VIEW, P.CASHIER_MANAGE,
    P.WAITER_VIEW, P.WAITER_MANAGE,
    P.TERMINALS_VIEW, P.TERMINALS_MANAGE,
    P.USERS_MANAGE,
    P.SETTINGS_MANAGE,
    P.BACKUP_MANAGE,
    P.AUDIT_VIEW,
  ],

  [SystemRole.CASHIER]: [
    P.ORDERS_VIEW, P.ORDERS_CREATE, P.ORDERS_EDIT, P.ORDERS_CHANGE_STATUS,
    P.TABLES_VIEW,
    P.MENU_VIEW,
    P.PAYMENTS_VIEW, P.PAYMENTS_CREATE,
    P.PRINTING_USE,
    P.CASHIER_VIEW,
  ],

  [SystemRole.WAITER]: [
    P.ORDERS_VIEW, P.ORDERS_CREATE, P.ORDERS_EDIT, P.ORDERS_CHANGE_STATUS,
    P.TABLES_VIEW,
    P.MENU_VIEW,
    P.WAITER_VIEW,
  ],

  [SystemRole.KITCHEN]: [
    P.ORDERS_VIEW, P.ORDERS_CHANGE_STATUS,
    P.MENU_VIEW,
    P.KITCHEN_VIEW,
    P.PRINTING_USE,
  ],

  /** Anonymous diners scanning a table QR. Deliberately tiny. */
  [SystemRole.CUSTOMER]: [P.MENU_VIEW, P.ORDERS_CREATE, P.ORDERS_VIEW],
};

/**
 * Permissions a terminal *type* may exercise even when no human has identified
 * themselves on it. The effective permission set of a request is always the
 * intersection of the terminal's ceiling and the acting user's role grants, so
 * plugging a kitchen QR into a manager's phone still yields kitchen powers only.
 */
export const TERMINAL_TYPE_CEILING: Readonly<Record<string, readonly string[]>> = {
  TABLE: [P.MENU_VIEW, P.ORDERS_CREATE, P.ORDERS_VIEW],
  KITCHEN: [P.MENU_VIEW, P.ORDERS_VIEW, P.ORDERS_CHANGE_STATUS, P.KITCHEN_VIEW, P.PRINTING_USE],
  KDS: [P.MENU_VIEW, P.ORDERS_VIEW, P.ORDERS_CHANGE_STATUS, P.KITCHEN_VIEW],
  BAR: [P.MENU_VIEW, P.ORDERS_VIEW, P.ORDERS_CHANGE_STATUS, P.KITCHEN_VIEW, P.PRINTING_USE],
  CASHIER: [
    P.MENU_VIEW, P.ORDERS_VIEW, P.ORDERS_CREATE, P.ORDERS_EDIT, P.ORDERS_CANCEL,
    P.ORDERS_CHANGE_STATUS, P.TABLES_VIEW, P.PAYMENTS_VIEW, P.PAYMENTS_CREATE,
    P.PAYMENTS_REFUND, P.PRINTING_USE, P.CASHIER_VIEW,
  ],
  WAITER: [
    P.MENU_VIEW, P.ORDERS_VIEW, P.ORDERS_CREATE, P.ORDERS_EDIT,
    P.ORDERS_CHANGE_STATUS, P.TABLES_VIEW, P.WAITER_VIEW,
  ],
  MANAGER: [WILDCARD_PERMISSION],
  PRINTER: [P.PRINTING_USE],
};

/** True when `granted` (which may contain the wildcard) covers `required`. */
export function grants(granted: Iterable<string>, required: string): boolean {
  for (const g of granted) {
    if (g === WILDCARD_PERMISSION || g === required) return true;
    // "orders.*" style scope wildcards, useful for custom roles.
    if (g.endsWith('.*') && required.startsWith(g.slice(0, -1))) return true;
  }
  return false;
}

/** Intersection honouring wildcards on either side. */
export function intersectPermissions(
  a: readonly string[],
  b: readonly string[],
): string[] {
  if (a.includes(WILDCARD_PERMISSION)) return [...b];
  if (b.includes(WILDCARD_PERMISSION)) return [...a];
  const inB = new Set(b);
  return a.filter((p) => inB.has(p) || grants(b, p));
}
