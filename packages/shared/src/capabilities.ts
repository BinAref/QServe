/**
 * License-gated capabilities (spec §2, §52).
 *
 * SETUP mode is a *real* environment: the restaurant builds its real menu,
 * branding and settings and keeps every byte of it after activation. What SETUP
 * withholds is live service — the LAN server never binds, so no phone on the
 * Wi-Fi can reach a menu, and no order can be created.
 *
 * The gate is enforced in one place (`LicenseGate` in the server) and consulted
 * by routes, by the LAN listener bootstrap and by the realtime bus.
 */

import { RestaurantMode } from './enums.js';

export const Capability = {
  /** Build categories, products, prices, options, add-ons. Always available. */
  MENU_AUTHORING: 'menu.authoring',
  /** Branding, themes, languages, restaurant profile. Always available. */
  BRANDING: 'branding',
  /** Render the customer menu locally for the owner to inspect. Always available. */
  MENU_PREVIEW: 'menu.preview',
  /** Local encrypted backup/restore. Always available — data portability matters
   *  most precisely when a restaurant has not yet paid. */
  BACKUP: 'backup',

  /** Create real tables and issue their QR codes. */
  TABLES_PROVISION: 'tables.provision',
  /** Create waiter/cashier/kitchen terminals and issue their QR codes. */
  TERMINALS_PROVISION: 'terminals.provision',
  /** Bind the HTTP/WebSocket listener to the LAN so staff and diners can connect. */
  LAN_SERVER: 'server.lan',
  /** Accept and mutate real orders. */
  ORDERS_RUNTIME: 'orders.runtime',
  /** Kitchen display service. */
  KITCHEN_RUNTIME: 'kitchen.runtime',
  /** Cashier and payment capture. */
  CASHIER_RUNTIME: 'cashier.runtime',
  /** Waiter terminals. */
  WAITER_RUNTIME: 'waiter.runtime',
  /** Physical printing. */
  PRINTING_RUNTIME: 'printing.runtime',
  /** Operational reporting over real orders. */
  REPORTS_RUNTIME: 'reports.runtime',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

export const ALL_CAPABILITIES: readonly Capability[] = Object.values(Capability);

/** Everything a restaurant may do before it has paid. */
export const SETUP_CAPABILITIES: readonly Capability[] = [
  Capability.MENU_AUTHORING,
  Capability.BRANDING,
  Capability.MENU_PREVIEW,
  Capability.BACKUP,
];

const SETUP_SET: ReadonlySet<string> = new Set(SETUP_CAPABILITIES);

/** Capabilities that only an ACTIVE, device-bound licence unlocks. */
export const LICENSED_CAPABILITIES: readonly Capability[] = ALL_CAPABILITIES.filter(
  (c) => !SETUP_SET.has(c),
);

export function capabilitiesForMode(mode: RestaurantMode): readonly Capability[] {
  return mode === RestaurantMode.OPERATIONAL ? ALL_CAPABILITIES : SETUP_CAPABILITIES;
}

export function isCapabilityAvailable(mode: RestaurantMode, cap: Capability): boolean {
  return mode === RestaurantMode.OPERATIONAL || SETUP_SET.has(cap);
}
