/**
 * Currencies the restaurant accepts.
 *
 * A restaurant on a border, or one serving tourists, prices some things in one
 * currency and some in another. The owner writes each one — code, symbol,
 * decimals, which side the symbol sits, and what it is worth against the base —
 * so adding the lira is typing `TRY` and `₺`, not shipping a new version.
 *
 * Exactly one currency is the **base**. It is what the till counts, what the
 * reports add up, and what a bill settles in. A partial unique index makes that
 * a property of the storage engine rather than a rule somebody can forget.
 */

import type { Db } from '@qserve/db';
import { fromDbJson, nowIso, toDbJson, transaction } from '@qserve/db';
import {
  conflict, CurrencyDisplay, notFound, validationError,
  type Currency, type CurrencyConfig, type Localised,
} from '@qserve/shared';

export interface CurrencyRow {
  code: string;
  symbol: string;
  name_json: string;
  decimals: number;
  symbol_position: 'before' | 'after';
  rate_to_base: number;
  display: 'CODE' | 'SYMBOL';
  is_base: number;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const toCurrency = (row: CurrencyRow): Currency => ({
  code: row.code,
  symbol: row.symbol,
  name: fromDbJson<Localised>(row.name_json, {}),
  decimals: row.decimals,
  symbolPosition: row.symbol_position,
  display: row.display,
  rateToBase: row.rate_to_base,
  isBase: row.is_base === 1,
  enabled: row.enabled === 1,
  sortOrder: row.sort_order,
});

export class CurrencyRepository {
  constructor(private readonly db: Db) {}

  list(): Currency[] {
    const rows = this.db
      .prepare('SELECT * FROM currencies ORDER BY is_base DESC, sort_order, code')
      .all() as CurrencyRow[];
    return rows.map(toCurrency);
  }

  /** What a price picker offers: the base first, then the rest in the owner's order. */
  enabled(): Currency[] {
    return this.list().filter((currency) => currency.enabled);
  }

  get(code: string): Currency | null {
    const row = this.db
      .prepare('SELECT * FROM currencies WHERE code = ?')
      .get(code.toUpperCase()) as CurrencyRow | undefined;
    return row ? toCurrency(row) : null;
  }

  /**
   * The base currency, or a sensible stand-in.
   *
   * The fallback exists for exactly one moment: an installation whose
   * restaurant row has not been created yet. Everywhere else there is a base,
   * because creating a restaurant creates one.
   */
  base(): Currency {
    const row = this.db
      .prepare('SELECT * FROM currencies WHERE is_base = 1')
      .get() as CurrencyRow | undefined;

    return row ? toCurrency(row) : {
      code: 'SAR', symbol: 'SAR', name: {}, decimals: 2, symbolPosition: 'after',
      display: CurrencyDisplay.SYMBOL,
      rateToBase: 1, isBase: true, enabled: true, sortOrder: 0,
    };
  }

  /**
   * Resolve the currency a price is in. `null` means "the base", which is what
   * every product that has never been given one holds.
   */
  resolve(code: string | null | undefined): Currency {
    if (!code) return this.base();
    return this.get(code) ?? this.base();
  }

  has(code: string): boolean {
    return this.get(code) !== null;
  }

  /** Create the first currency, from the restaurant's own configuration. */
  seedBase(currency: CurrencyConfig): Currency {
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO currencies
          (code, symbol, name_json, decimals, symbol_position, display,
           rate_to_base, is_base, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, '{}', ?, ?, 'SYMBOL', 1, 1, 1, 0, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          symbol = excluded.symbol,
          decimals = excluded.decimals,
          symbol_position = excluded.symbol_position,
          updated_at = excluded.updated_at
      `)
      .run(
        currency.code.toUpperCase(), currency.symbol, currency.decimals,
        currency.symbolPosition, at, at,
      );
    return this.get(currency.code)!;
  }

  create(input: {
    code: string;
    symbol: string;
    name?: Localised;
    decimals: number;
    symbolPosition: 'before' | 'after';
    display?: CurrencyDisplay;
    rateToBase: number;
    sortOrder?: number;
  }): Currency {
    const code = input.code.toUpperCase();
    if (this.has(code)) throw conflict('that currency already exists', { code });

    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO currencies
          (code, symbol, name_json, decimals, symbol_position, display,
           rate_to_base, is_base, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
      `)
      .run(
        code, input.symbol, toDbJson(input.name ?? {}), input.decimals,
        input.symbolPosition, input.display ?? CurrencyDisplay.SYMBOL,
        input.rateToBase, input.sortOrder ?? this.list().length, at, at,
      );
    return this.get(code)!;
  }

  update(code: string, patch: {
    symbol?: string;
    name?: Localised;
    decimals?: number;
    symbolPosition?: 'before' | 'after';
    display?: CurrencyDisplay;
    rateToBase?: number;
    enabled?: boolean;
    sortOrder?: number;
  }): Currency {
    const existing = this.get(code);
    if (!existing) throw notFound('currency', code);

    // Disabling the base would leave the till counting a currency the owner
    // says they do not accept.
    if (patch.enabled === false && existing.isBase) {
      throw conflict('the base currency is always accepted');
    }
    // The base is the unit everything else is measured against; it is 1 by
    // definition, and letting it drift would silently reprice the whole menu.
    if (patch.rateToBase !== undefined && existing.isBase && patch.rateToBase !== 1) {
      throw conflict('the base currency’s rate is 1 by definition');
    }

    const assignments: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.symbol !== undefined) set('symbol', patch.symbol);
    if (patch.name !== undefined) set('name_json', toDbJson(patch.name));
    if (patch.decimals !== undefined) set('decimals', patch.decimals);
    if (patch.symbolPosition !== undefined) set('symbol_position', patch.symbolPosition);
    if (patch.display !== undefined) set('display', patch.display);
    if (patch.rateToBase !== undefined) set('rate_to_base', patch.rateToBase);
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.sortOrder !== undefined) set('sort_order', patch.sortOrder);

    if (assignments.length > 0) {
      set('updated_at', nowIso());
      this.db
        .prepare(`UPDATE currencies SET ${assignments.join(', ')} WHERE code = ?`)
        .run(...values, existing.code);
    }
    return this.get(existing.code)!;
  }

  /**
   * Move the base to another currency.
   *
   * Every other rate is expressed against the base, so moving it means
   * re-expressing all of them — done in one transaction, because a half-moved
   * base would misprice every menu item priced in a foreign currency.
   */
  setBase(code: string): Currency {
    const target = this.get(code);
    if (!target) throw notFound('currency', code);
    if (target.isBase) return target;
    if (target.rateToBase <= 0) {
      throw conflict('this currency needs a rate before it can become the base');
    }

    transaction(this.db, () => {
      const factor = 1 / target.rateToBase;
      // Clear first: the partial unique index allows only one base at a time,
      // so the old one has to step down before the new one steps up.
      this.db.prepare('UPDATE currencies SET is_base = 0').run();
      this.db
        .prepare('UPDATE currencies SET rate_to_base = rate_to_base * ?, updated_at = ?')
        .run(factor, nowIso());
      this.db
        .prepare('UPDATE currencies SET is_base = 1, rate_to_base = 1, enabled = 1 WHERE code = ?')
        .run(target.code);
    });

    return this.get(target.code)!;
  }

  /** How many products and add-ons are priced in a currency. */
  usage(code: string): { products: number; addons: number } {
    const count = (table: string): number => (this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE currency_code = ?`)
      .get(code) as { n: number }).n;
    return { products: count('products'), addons: count('addons') };
  }

  delete(code: string): void {
    const currency = this.get(code);
    if (!currency) throw notFound('currency', code);
    if (currency.isBase) throw conflict('the base currency cannot be removed');

    const usage = this.usage(currency.code);
    if (usage.products + usage.addons > 0) {
      // Deleting would leave those prices meaning something else entirely.
      throw validationError('this currency is still used on the menu', {
        field: 'code', ...usage,
      });
    }
    this.db.prepare('DELETE FROM currencies WHERE code = ?').run(currency.code);
  }
}
