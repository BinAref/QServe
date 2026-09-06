/**
 * Settings and the restaurant profile (spec §35).
 *
 * Settings are a typed key/value store rather than a wide table so a module can
 * add its own configuration without a migration. Each key is namespaced by the
 * module that owns it (`orders.*`, `sound.*`, `backup.*`).
 */

import type { Db } from '@qserve/db';
import { fromDbJson, fromDbStringList, nowIso, toDbBool, toDbJson } from '@qserve/db';
import {
  DEFAULT_CURRENCY, type CurrencyConfig, type Localised, type RestaurantProfile,
} from '@qserve/shared';

export interface RestaurantRow {
  singleton: number;
  restaurant_id: string;
  name_json: string;
  legal_name: string | null;
  logo_asset_id: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  tax_number: string | null;
  currency_json: string;
  tax_rate_percent: number;
  tax_inclusive: number;
  service_rate_percent: number;
  default_locale: string;
  enabled_locales_json: string;
  theme_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Defaults for every setting the product ships with. A missing row reads as the
 * default, so upgrades that introduce a setting need no data migration.
 */
export const DEFAULT_SETTINGS: Readonly<Record<string, unknown>> = {
  'orders.autoAcceptFromCustomer': false,
  'orders.requireGuestCount': false,
  'orders.allowCustomerNotes': true,
  'orders.dailyNumberReset': true,
  'orders.customerMayCancelWithinSeconds': 120,

  'kitchen.groupByStation': true,
  'kitchen.showSourceBadge': true,
  'kitchen.urgentAfterMinutes': 15,

  'cashier.requireUserForPayment': true,
  'cashier.allowRefund': true,
  'cashier.printReceiptOnPayment': true,

  'waiter.showAllTables': true,
  'waiter.mayChangeOrderStatus': true,

  'printing.autoPrintKitchenTicket': true,
  'printing.retryLimit': 3,

  'backup.automaticEnabled': false,
  'backup.automaticIntervalHours': 24,
  'backup.keepCount': 7,
  /** Set by the owner; used for automatic backups only. See docs/SECURITY.md. */
  'backup.passphrase': null,

  'menu.showImages': true,
  'menu.showPrices': true,
  'menu.showUnavailableProducts': true,

  'notifications.tableCallsWaiter': true,

  /**
   * Optional app lock (the owner's choice, off by default). When enabled the
   * management console opens on a lock screen and stays locked after the idle
   * timeout — for a PC sitting in a busy back room where anyone might walk past.
   * The passphrase itself is a scrypt hash, never a readable setting.
   */
  'security.appLockEnabled': false,
  'security.appLockHash': null,
  'security.appLockIdleMinutes': 30,
  /** Shown on the lock screen so staff know whose machine they are looking at. */
  'security.appLockHint': null,

  /**
   * Last vendor contact and pricing seen on the licence screen, cached so the
   * screen still reads sensibly with the internet unplugged.
   */
  'license.vendorInfoCache': null,
};

/** Settings that are credentials rather than preferences, and are never listed. */
export const SECRET_SETTING_KEYS: readonly string[] = [
  'backup.passphrase',
  'security.appLockHash',
];

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  /* ------------------------------------------------------------ profile */

  getRestaurantRow(): RestaurantRow | undefined {
    return this.db.prepare('SELECT * FROM restaurant WHERE singleton = 1').get() as
      | RestaurantRow
      | undefined;
  }

  createRestaurant(input: {
    restaurantId: string;
    name: Localised;
    defaultLocale: string;
    enabledLocales: readonly string[];
    themeId: string;
    currency?: CurrencyConfig;
  }): RestaurantRow {
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO restaurant
          (singleton, restaurant_id, name_json, currency_json, default_locale,
           enabled_locales_json, theme_id, created_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.restaurantId, toDbJson(input.name), toDbJson(input.currency ?? DEFAULT_CURRENCY),
        input.defaultLocale, toDbJson(input.enabledLocales), input.themeId, at, at,
      );
    return this.getRestaurantRow()!;
  }

  /**
   * Replace the Restaurant ID. Called exactly once, when a SETUP-mode
   * installation is activated and learns its vendor-issued identity — the menu
   * and settings built beforehand carry over untouched (spec §2).
   */
  adoptRestaurantId(restaurantId: string): void {
    this.db
      .prepare('UPDATE restaurant SET restaurant_id = ?, updated_at = ? WHERE singleton = 1')
      .run(restaurantId, nowIso());
  }

  updateRestaurant(patch: Partial<{
    name: Localised;
    legalName: string | null;
    logoAssetId: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    taxNumber: string | null;
    currency: CurrencyConfig;
    taxRatePercent: number;
    taxInclusive: boolean;
    serviceRatePercent: number;
    defaultLocale: string;
    enabledLocales: readonly string[];
    themeId: string;
  }>): void {
    const map: Record<string, [string, unknown]> = {
      name: ['name_json', patch.name !== undefined ? toDbJson(patch.name) : undefined],
      legalName: ['legal_name', patch.legalName],
      logoAssetId: ['logo_asset_id', patch.logoAssetId],
      address: ['address', patch.address],
      phone: ['phone', patch.phone],
      email: ['email', patch.email],
      taxNumber: ['tax_number', patch.taxNumber],
      currency: ['currency_json', patch.currency !== undefined ? toDbJson(patch.currency) : undefined],
      taxRatePercent: ['tax_rate_percent', patch.taxRatePercent],
      taxInclusive: ['tax_inclusive', patch.taxInclusive !== undefined ? toDbBool(patch.taxInclusive) : undefined],
      serviceRatePercent: ['service_rate_percent', patch.serviceRatePercent],
      defaultLocale: ['default_locale', patch.defaultLocale],
      enabledLocales: ['enabled_locales_json', patch.enabledLocales !== undefined ? toDbJson(patch.enabledLocales) : undefined],
      themeId: ['theme_id', patch.themeId],
    };

    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      const entry = map[key];
      if (!entry || entry[1] === undefined) continue;
      assignments.push(`${entry[0]} = ?`);
      values.push(entry[1]);
    }
    if (assignments.length === 0) return;

    this.db
      .prepare(`UPDATE restaurant SET ${assignments.join(', ')}, updated_at = ? WHERE singleton = 1`)
      .run(...values, nowIso());
  }

  profile(): RestaurantProfile | null {
    const row = this.getRestaurantRow();
    if (!row) return null;
    return {
      restaurantId: row.restaurant_id,
      name: fromDbJson<Localised>(row.name_json, {}),
      legalName: row.legal_name,
      logoAssetId: row.logo_asset_id,
      address: row.address,
      phone: row.phone,
      email: row.email,
      taxNumber: row.tax_number,
      currency: fromDbJson<CurrencyConfig>(row.currency_json, DEFAULT_CURRENCY),
      taxRatePercent: row.tax_rate_percent,
      taxInclusive: row.tax_inclusive === 1,
      serviceRatePercent: row.service_rate_percent,
      defaultLocale: row.default_locale,
      enabledLocales: fromDbStringList(row.enabled_locales_json),
      themeId: row.theme_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /* ----------------------------------------------------------- settings */

  get<T>(key: string): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return DEFAULT_SETTINGS[key] as T;
    return fromDbJson<T>(row.value_json, DEFAULT_SETTINGS[key] as T);
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(`
        INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(key, toDbJson(value), nowIso());
  }

  /** Defaults overlaid with whatever the restaurant has explicitly changed. */
  all(): Record<string, unknown> {
    const stored = this.db.prepare('SELECT key, value_json FROM settings').all() as {
      key: string; value_json: string;
    }[];
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of stored) out[row.key] = fromDbJson<unknown>(row.value_json, null);
    return out;
  }

  /* ----------------------------------------------------------- counters */

  nextCounter(name: string): number {
    this.db
      .prepare(`
        INSERT INTO counters (name, value) VALUES (?, 1)
        ON CONFLICT(name) DO UPDATE SET value = value + 1
      `)
      .run(name);
    return (this.db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as
      { value: number }).value;
  }
}
