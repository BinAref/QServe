/**
 * Menu storage: categories, products, options, choices and add-ons.
 *
 * The menu is authored in SETUP mode and kept forever (spec §2, §34). Nothing
 * here is gated on the licence — a restaurant that has not yet paid still owns
 * every byte it typed, and activation changes none of it.
 */

import type { Db } from '@qserve/db';
import { fromDbBool, fromDbJson, nowIso, toDbBool, toDbJson } from '@qserve/db';
import {
  newEntityId,
  type Addon, type Category, type Localised, type OptionChoice,
  type Product, type ProductOption,
} from '@qserve/shared';

interface CategoryRow {
  id: string; name_json: string; description_json: string; image_asset_id: string | null;
  sort_order: number; visible: number; created_at: string; updated_at: string;
}

interface ProductRow {
  id: string; category_id: string; name_json: string; description_json: string;
  image_asset_id: string | null; price_minor: number; currency_code: string | null;
  sort_order: number;
  visible: number; available: number; station: string | null;
  preparation_minutes: number | null; created_at: string; updated_at: string;
}

interface OptionRow {
  id: string; product_id: string; name_json: string; required: number;
  min_select: number; max_select: number; sort_order: number;
}

interface ChoiceRow {
  id: string; option_id: string; name_json: string; price_delta_minor: number;
  sort_order: number; available: number; is_default: number;
}

interface AddonRow {
  id: string; name_json: string; price_minor: number; currency_code: string | null;
  sort_order: number;
  available: number; created_at: string;
}

export interface CategoryInput {
  readonly name: Localised;
  readonly description?: Localised;
  readonly imageAssetId?: string | null;
  readonly visible?: boolean;
  readonly sortOrder?: number;
}

export interface ProductInput {
  readonly categoryId: string;
  readonly name: Localised;
  readonly description?: Localised;
  readonly imageAssetId?: string | null;
  readonly priceMinor: number;
  /** Omitted or null means the restaurant's base currency. */
  readonly currencyCode?: string | null;
  readonly visible?: boolean;
  readonly available?: boolean;
  readonly station?: string | null;
  readonly preparationMinutes?: number | null;
  readonly sortOrder?: number;
}

export class MenuRepository {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------- categories */

  createCategory(input: CategoryInput): Category {
    const id = newEntityId('CAT');
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO categories
          (id, name_json, description_json, image_asset_id, sort_order, visible, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, toDbJson(input.name), toDbJson(input.description ?? {}), input.imageAssetId ?? null,
        input.sortOrder ?? this.nextSortOrder('categories'), toDbBool(input.visible ?? true), at, at,
      );
    return this.getCategory(id)!;
  }

  getCategory(id: string): Category | null {
    const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as
      | CategoryRow
      | undefined;
    return row ? toCategory(row) : null;
  }

  listCategories(options: { visibleOnly?: boolean } = {}): Category[] {
    const where = options.visibleOnly ? 'WHERE visible = 1' : '';
    return (
      this.db
        .prepare(`SELECT * FROM categories ${where} ORDER BY sort_order, created_at`)
        .all() as CategoryRow[]
    ).map(toCategory);
  }

  updateCategory(id: string, patch: Partial<CategoryInput>): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { assignments.push('name_json = ?'); values.push(toDbJson(patch.name)); }
    if (patch.description !== undefined) { assignments.push('description_json = ?'); values.push(toDbJson(patch.description)); }
    if (patch.imageAssetId !== undefined) { assignments.push('image_asset_id = ?'); values.push(patch.imageAssetId); }
    if (patch.visible !== undefined) { assignments.push('visible = ?'); values.push(toDbBool(patch.visible)); }
    if (patch.sortOrder !== undefined) { assignments.push('sort_order = ?'); values.push(patch.sortOrder); }
    if (assignments.length === 0) return;
    this.db
      .prepare(`UPDATE categories SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, nowIso(), id);
  }

  deleteCategory(id: string): void {
    this.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  }

  /* ------------------------------------------------------------ products */

  createProduct(input: ProductInput): Product {
    const id = newEntityId('PRD');
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO products
          (id, category_id, name_json, description_json, image_asset_id, price_minor,
           currency_code, sort_order, visible, available, station, preparation_minutes,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, input.categoryId, toDbJson(input.name), toDbJson(input.description ?? {}),
        input.imageAssetId ?? null, input.priceMinor, input.currencyCode ?? null,
        input.sortOrder ?? this.nextSortOrder('products', input.categoryId),
        toDbBool(input.visible ?? true), toDbBool(input.available ?? true),
        input.station ?? null, input.preparationMinutes ?? null, at, at,
      );
    return this.getProduct(id)!;
  }

  getProduct(id: string): Product | null {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as
      | ProductRow
      | undefined;
    if (!row) return null;
    return toProduct(row, this.optionsForProduct(id), this.addonsForProduct(id));
  }

  listProducts(options: { categoryId?: string; visibleOnly?: boolean } = {}): Product[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (options.categoryId) { conditions.push('category_id = ?'); values.push(options.categoryId); }
    if (options.visibleOnly) conditions.push('visible = 1');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = this.db
      .prepare(`SELECT * FROM products ${where} ORDER BY sort_order, created_at`)
      .all(...values) as ProductRow[];

    // One query per collection rather than per product: a 300-item menu is
    // rendered on every table's phone, so this path must stay cheap.
    const optionsByProduct = this.allOptionsGrouped();
    const addonsByProduct = this.allAddonsGrouped();

    return rows.map((row) =>
      toProduct(row, optionsByProduct.get(row.id) ?? [], addonsByProduct.get(row.id) ?? []));
  }

  updateProduct(id: string, patch: Partial<ProductInput>): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`); values.push(value);
    };
    if (patch.categoryId !== undefined) push('category_id', patch.categoryId);
    if (patch.name !== undefined) push('name_json', toDbJson(patch.name));
    if (patch.description !== undefined) push('description_json', toDbJson(patch.description));
    if (patch.imageAssetId !== undefined) push('image_asset_id', patch.imageAssetId);
    if (patch.priceMinor !== undefined) push('price_minor', patch.priceMinor);
    if (patch.currencyCode !== undefined) push('currency_code', patch.currencyCode);
    if (patch.visible !== undefined) push('visible', toDbBool(patch.visible));
    if (patch.available !== undefined) push('available', toDbBool(patch.available));
    if (patch.station !== undefined) push('station', patch.station);
    if (patch.preparationMinutes !== undefined) push('preparation_minutes', patch.preparationMinutes);
    if (patch.sortOrder !== undefined) push('sort_order', patch.sortOrder);
    if (assignments.length === 0) return;

    this.db
      .prepare(`UPDATE products SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, nowIso(), id);
  }

  deleteProduct(id: string): void {
    this.db.prepare('DELETE FROM products WHERE id = ?').run(id);
  }

  /** Persist a drag-and-drop reorder in one transaction (spec §34). */
  reorder(table: 'categories' | 'products', orderedIds: readonly string[]): void {
    const update = this.db.prepare(`UPDATE ${table} SET sort_order = ?, updated_at = ? WHERE id = ?`);
    const at = nowIso();
    this.db.transaction(() => {
      orderedIds.forEach((id, index) => update.run(index, at, id));
    })();
  }

  private nextSortOrder(table: 'categories' | 'products', categoryId?: string): number {
    const row = categoryId
      ? this.db
          .prepare(`SELECT MAX(sort_order) AS max FROM ${table} WHERE category_id = ?`)
          .get(categoryId) as { max: number | null }
      : this.db.prepare(`SELECT MAX(sort_order) AS max FROM ${table}`).get() as { max: number | null };
    return (row.max ?? -1) + 1;
  }

  /* ------------------------------------------------------------- options */

  createOption(productId: string, input: {
    name: Localised; required?: boolean; minSelect?: number; maxSelect?: number; sortOrder?: number;
  }): ProductOption {
    const id = newEntityId('OPT');
    this.db
      .prepare(`
        INSERT INTO product_options
          (id, product_id, name_json, required, min_select, max_select, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, productId, toDbJson(input.name), toDbBool(input.required ?? false),
        input.minSelect ?? (input.required ? 1 : 0), input.maxSelect ?? 1, input.sortOrder ?? 0,
      );
    return this.getOption(id)!;
  }

  getOption(id: string): ProductOption | null {
    const row = this.db.prepare('SELECT * FROM product_options WHERE id = ?').get(id) as
      | OptionRow
      | undefined;
    return row ? toOption(row, this.choicesForOption(id)) : null;
  }

  updateOption(id: string, patch: {
    name?: Localised; required?: boolean; minSelect?: number; maxSelect?: number; sortOrder?: number;
  }): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { assignments.push('name_json = ?'); values.push(toDbJson(patch.name)); }
    if (patch.required !== undefined) { assignments.push('required = ?'); values.push(toDbBool(patch.required)); }
    if (patch.minSelect !== undefined) { assignments.push('min_select = ?'); values.push(patch.minSelect); }
    if (patch.maxSelect !== undefined) { assignments.push('max_select = ?'); values.push(patch.maxSelect); }
    if (patch.sortOrder !== undefined) { assignments.push('sort_order = ?'); values.push(patch.sortOrder); }
    if (assignments.length === 0) return;
    this.db.prepare(`UPDATE product_options SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
  }

  deleteOption(id: string): void {
    this.db.prepare('DELETE FROM product_options WHERE id = ?').run(id);
  }

  createChoice(optionId: string, input: {
    name: Localised; priceDeltaMinor?: number; sortOrder?: number;
    available?: boolean; isDefault?: boolean;
  }): OptionChoice {
    const id = newEntityId('CHO');
    this.db
      .prepare(`
        INSERT INTO option_choices
          (id, option_id, name_json, price_delta_minor, sort_order, available, is_default)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, optionId, toDbJson(input.name), input.priceDeltaMinor ?? 0,
        input.sortOrder ?? 0, toDbBool(input.available ?? true), toDbBool(input.isDefault ?? false),
      );
    return this.choicesForOption(optionId).find((c) => c.id === id)!;
  }

  updateChoice(id: string, patch: {
    name?: Localised; priceDeltaMinor?: number; sortOrder?: number;
    available?: boolean; isDefault?: boolean;
  }): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { assignments.push('name_json = ?'); values.push(toDbJson(patch.name)); }
    if (patch.priceDeltaMinor !== undefined) { assignments.push('price_delta_minor = ?'); values.push(patch.priceDeltaMinor); }
    if (patch.sortOrder !== undefined) { assignments.push('sort_order = ?'); values.push(patch.sortOrder); }
    if (patch.available !== undefined) { assignments.push('available = ?'); values.push(toDbBool(patch.available)); }
    if (patch.isDefault !== undefined) { assignments.push('is_default = ?'); values.push(toDbBool(patch.isDefault)); }
    if (assignments.length === 0) return;
    this.db.prepare(`UPDATE option_choices SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
  }

  getChoice(id: string): OptionChoice | null {
    const row = this.db
      .prepare('SELECT * FROM option_choices WHERE id = ?')
      .get(id) as ChoiceRow | undefined;
    return row ? toChoice(row) : null;
  }

  deleteChoice(id: string): void {
    this.db.prepare('DELETE FROM option_choices WHERE id = ?').run(id);
  }

  private optionsForProduct(productId: string): ProductOption[] {
    const rows = this.db
      .prepare('SELECT * FROM product_options WHERE product_id = ? ORDER BY sort_order')
      .all(productId) as OptionRow[];
    return rows.map((row) => toOption(row, this.choicesForOption(row.id)));
  }

  private choicesForOption(optionId: string): OptionChoice[] {
    return (
      this.db
        .prepare('SELECT * FROM option_choices WHERE option_id = ? ORDER BY sort_order')
        .all(optionId) as ChoiceRow[]
    ).map(toChoice);
  }

  private allOptionsGrouped(): Map<string, ProductOption[]> {
    const optionRows = this.db
      .prepare('SELECT * FROM product_options ORDER BY sort_order')
      .all() as OptionRow[];
    const choiceRows = this.db
      .prepare('SELECT * FROM option_choices ORDER BY sort_order')
      .all() as ChoiceRow[];

    const choicesByOption = new Map<string, OptionChoice[]>();
    for (const row of choiceRows) {
      const list = choicesByOption.get(row.option_id) ?? [];
      list.push(toChoice(row));
      choicesByOption.set(row.option_id, list);
    }

    const byProduct = new Map<string, ProductOption[]>();
    for (const row of optionRows) {
      const list = byProduct.get(row.product_id) ?? [];
      list.push(toOption(row, choicesByOption.get(row.id) ?? []));
      byProduct.set(row.product_id, list);
    }
    return byProduct;
  }

  /* -------------------------------------------------------------- addons */

  createAddon(input: {
    name: Localised; priceMinor: number; currencyCode?: string | null;
    sortOrder?: number; available?: boolean;
  }): Addon {
    const id = newEntityId('ADD');
    this.db
      .prepare(`
        INSERT INTO addons
          (id, name_json, price_minor, currency_code, sort_order, available, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, toDbJson(input.name), input.priceMinor, input.currencyCode ?? null,
        input.sortOrder ?? 0, toDbBool(input.available ?? true), nowIso(),
      );
    return this.getAddon(id)!;
  }

  getAddon(id: string): Addon | null {
    const row = this.db.prepare('SELECT * FROM addons WHERE id = ?').get(id) as AddonRow | undefined;
    return row ? toAddon(row) : null;
  }

  listAddons(): Addon[] {
    return (this.db.prepare('SELECT * FROM addons ORDER BY sort_order, created_at').all() as AddonRow[])
      .map(toAddon);
  }

  updateAddon(id: string, patch: {
    name?: Localised; priceMinor?: number; currencyCode?: string | null;
    sortOrder?: number; available?: boolean;
  }): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { assignments.push('name_json = ?'); values.push(toDbJson(patch.name)); }
    if (patch.priceMinor !== undefined) { assignments.push('price_minor = ?'); values.push(patch.priceMinor); }
    if (patch.currencyCode !== undefined) { assignments.push('currency_code = ?'); values.push(patch.currencyCode); }
    if (patch.sortOrder !== undefined) { assignments.push('sort_order = ?'); values.push(patch.sortOrder); }
    if (patch.available !== undefined) { assignments.push('available = ?'); values.push(toDbBool(patch.available)); }
    if (assignments.length === 0) return;
    this.db.prepare(`UPDATE addons SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
  }

  deleteAddon(id: string): void {
    this.db.prepare('DELETE FROM addons WHERE id = ?').run(id);
  }

  setProductAddons(productId: string, addonIds: readonly string[]): void {
    const remove = this.db.prepare('DELETE FROM product_addons WHERE product_id = ?');
    const add = this.db.prepare(
      'INSERT OR IGNORE INTO product_addons (product_id, addon_id) VALUES (?, ?)',
    );
    this.db.transaction(() => {
      remove.run(productId);
      for (const addonId of addonIds) add.run(productId, addonId);
    })();
  }

  private addonsForProduct(productId: string): Addon[] {
    return (
      this.db
        .prepare(`
          SELECT a.* FROM product_addons pa JOIN addons a ON a.id = pa.addon_id
          WHERE pa.product_id = ? ORDER BY a.sort_order
        `)
        .all(productId) as AddonRow[]
    ).map(toAddon);
  }

  private allAddonsGrouped(): Map<string, Addon[]> {
    const rows = this.db
      .prepare(`
        SELECT pa.product_id, a.* FROM product_addons pa
        JOIN addons a ON a.id = pa.addon_id ORDER BY a.sort_order
      `)
      .all() as (AddonRow & { product_id: string })[];

    const byProduct = new Map<string, Addon[]>();
    for (const row of rows) {
      const list = byProduct.get(row.product_id) ?? [];
      list.push(toAddon(row));
      byProduct.set(row.product_id, list);
    }
    return byProduct;
  }

  /** Distinct kitchen stations in use. Drives print routing configuration. */
  listStations(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT station FROM products WHERE station IS NOT NULL AND station != ''")
        .all() as { station: string }[]
    ).map((row) => row.station).sort();
  }
}

/* ------------------------------------------------------------- projection */

const localised = (value: string): Localised => fromDbJson<Localised>(value, {});

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: localised(row.name_json),
    description: localised(row.description_json),
    imageAssetId: row.image_asset_id,
    sortOrder: row.sort_order,
    visible: fromDbBool(row.visible),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProduct(row: ProductRow, options: ProductOption[], addons: Addon[]): Product {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: localised(row.name_json),
    description: localised(row.description_json),
    imageAssetId: row.image_asset_id,
    priceMinor: row.price_minor,
    currencyCode: row.currency_code,
    sortOrder: row.sort_order,
    visible: fromDbBool(row.visible),
    available: fromDbBool(row.available),
    station: row.station,
    preparationMinutes: row.preparation_minutes,
    options,
    addons,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOption(row: OptionRow, choices: OptionChoice[]): ProductOption {
  return {
    id: row.id,
    name: localised(row.name_json),
    required: fromDbBool(row.required),
    minSelect: row.min_select,
    maxSelect: row.max_select,
    sortOrder: row.sort_order,
    choices,
  };
}

function toChoice(row: ChoiceRow): OptionChoice {
  return {
    id: row.id,
    name: localised(row.name_json),
    priceDeltaMinor: row.price_delta_minor,
    sortOrder: row.sort_order,
    available: fromDbBool(row.available),
    isDefault: fromDbBool(row.is_default),
  };
}

function toAddon(row: AddonRow): Addon {
  return {
    id: row.id,
    name: localised(row.name_json),
    priceMinor: row.price_minor,
    currencyCode: row.currency_code,
    sortOrder: row.sort_order,
    available: fromDbBool(row.available),
  };
}
