/**
 * Content translation catalogue.
 *
 * A restaurant's menu is not the only thing a diner reads. Category names,
 * product descriptions, option labels, choice names, add-ons, station names —
 * every one of them was typed by the owner, and every one of them has to appear
 * in a new language. So "add a language" cannot mean only the interface.
 *
 * This module turns all of that into one flat, translator-friendly map and
 * writes a translated map back. The owner's workflow is deliberately mundane:
 *
 *     copy the JSON → translate it anywhere → paste it back → save
 *
 * No integration, no API key, no account. It works with a translator, a
 * colleague, or a chat window, and it works with the internet unplugged for
 * everything except the translating itself.
 *
 * Keys are `kind:id:field`, so a translator sees stable identifiers and a
 * re-export after the menu changes lines up with the previous one.
 */

import type { Db } from '@qserve/db';
import { fromDbJson, nowIso, toDbJson } from '@qserve/db';
import { validationError, type Localised } from '@qserve/shared';

/**
 * Every localised column in the database, as data.
 *
 * Adding a translatable field later is one entry here — the export, the import,
 * the coverage report and the console all pick it up with no further change.
 */
interface TranslatableField {
  /** Key prefix, and the label a translator sees. */
  readonly kind: string;
  readonly table: string;
  readonly column: string;
  readonly field: string;
  readonly idColumn: string;
  /** Deterministic export order, so two exports diff cleanly. */
  readonly orderBy: string;
  /** Exactly one row: the key is `kind:main:field`. */
  readonly singleton?: boolean;
}

const TRANSLATABLE: readonly TranslatableField[] = [
  { kind: 'restaurant', table: 'restaurant', column: 'name_json', field: 'name',
    idColumn: 'singleton', orderBy: 'singleton', singleton: true },

  { kind: 'category', table: 'categories', column: 'name_json', field: 'name',
    idColumn: 'id', orderBy: 'sort_order, id' },
  { kind: 'category', table: 'categories', column: 'description_json', field: 'description',
    idColumn: 'id', orderBy: 'sort_order, id' },

  { kind: 'product', table: 'products', column: 'name_json', field: 'name',
    idColumn: 'id', orderBy: 'category_id, sort_order, id' },
  { kind: 'product', table: 'products', column: 'description_json', field: 'description',
    idColumn: 'id', orderBy: 'category_id, sort_order, id' },

  { kind: 'option', table: 'product_options', column: 'name_json', field: 'name',
    idColumn: 'id', orderBy: 'product_id, sort_order, id' },
  { kind: 'choice', table: 'option_choices', column: 'name_json', field: 'name',
    idColumn: 'id', orderBy: 'option_id, sort_order, id' },
  { kind: 'addon', table: 'addons', column: 'name_json', field: 'name',
    idColumn: 'id', orderBy: 'sort_order, id' },

  { kind: 'terminal', table: 'terminals', column: 'name_json', field: 'name',
    idColumn: 'id', orderBy: 'terminal_type, created_at' },
  { kind: 'role', table: 'roles', column: 'name_json', field: 'name',
    idColumn: 'id', orderBy: 'key' },
];

const SINGLETON_ID = 'main';

export const contentKey = (kind: string, id: string, field: string): string =>
  `${kind}:${id}:${field}`;

export function parseContentKey(key: string): { kind: string; id: string; field: string } | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [kind, id, field] = parts as [string, string, string];
  if (!kind || !id || !field) return null;
  return { kind, id, field };
}

export interface ContentEntry {
  readonly key: string;
  readonly kind: string;
  readonly id: string;
  readonly field: string;
  /** The text in the source locale, for the translator to work from. */
  readonly source: string;
  /** What the target locale already has, if anything. */
  readonly current: string;
}

export interface ImportOutcome {
  readonly applied: number;
  readonly skippedUnknown: string[];
  readonly skippedEmpty: number;
}

export class ContentTranslationRepository {
  constructor(private readonly db: Db) {}

  /**
   * Every translatable text, with the source text and whatever the target
   * locale already holds.
   */
  collect(sourceLocale: string, targetLocale: string): ContentEntry[] {
    const entries: ContentEntry[] = [];

    for (const definition of TRANSLATABLE) {
      const rows = this.db
        .prepare(`SELECT ${definition.idColumn} AS row_id, ${definition.column} AS value
                  FROM ${definition.table} ORDER BY ${definition.orderBy}`)
        .all() as { row_id: string | number; value: string }[];

      for (const row of rows) {
        const localised = fromDbJson<Localised>(row.value, {});
        const id = definition.singleton ? SINGLETON_ID : String(row.row_id);

        // A field the owner never filled in is not something to translate.
        const source = localised[sourceLocale] ?? localised['*'] ?? '';
        const current = localised[targetLocale] ?? '';
        if (source === '' && current === '') continue;

        entries.push({
          key: contentKey(definition.kind, id, definition.field),
          kind: definition.kind,
          id,
          field: definition.field,
          source,
          current,
        });
      }
    }
    return entries;
  }

  /**
   * Write a translated map back for one locale.
   *
   * Merges: a key the owner left blank keeps whatever was there, and a key the
   * import does not mention is untouched. That makes pasting a partial
   * translation safe, which matters because a menu grows between exports.
   */
  apply(targetLocale: string, translations: Readonly<Record<string, string>>): ImportOutcome {
    const byKind = new Map<string, TranslatableField[]>();
    for (const definition of TRANSLATABLE) {
      byKind.set(definition.kind, [...(byKind.get(definition.kind) ?? []), definition]);
    }

    const skippedUnknown: string[] = [];
    let applied = 0;
    let skippedEmpty = 0;

    const write = this.db.transaction(() => {
      for (const [key, rawValue] of Object.entries(translations)) {
        const parsed = parseContentKey(key);
        if (!parsed) {
          skippedUnknown.push(key);
          continue;
        }
        const definition = byKind.get(parsed.kind)?.find((d) => d.field === parsed.field);
        if (!definition) {
          skippedUnknown.push(key);
          continue;
        }

        const value = typeof rawValue === 'string' ? rawValue.trim() : '';
        if (value === '') {
          skippedEmpty += 1;
          continue;
        }

        const where = definition.singleton
          ? 'singleton = 1'
          : `${definition.idColumn} = ?`;
        const params = definition.singleton ? [] : [parsed.id];

        const row = this.db
          .prepare(`SELECT ${definition.column} AS value FROM ${definition.table} WHERE ${where}`)
          .get(...params) as { value: string } | undefined;

        // A key for a product deleted since the export is reported, not fatal.
        if (!row) {
          skippedUnknown.push(key);
          continue;
        }

        const localised: Record<string, string> = { ...fromDbJson<Localised>(row.value, {}) };
        localised[targetLocale] = value;

        this.db
          .prepare(`UPDATE ${definition.table} SET ${definition.column} = ? WHERE ${where}`)
          .run(toDbJson(localised), ...params);
        applied += 1;
      }
    });
    write.immediate();

    return { applied, skippedUnknown, skippedEmpty };
  }

  /**
   * Remove a locale from every localised column. Used when a restaurant deletes
   * a language it added, so the menu does not keep dead translations.
   */
  purge(locale: string): number {
    let cleared = 0;
    const purge = this.db.transaction(() => {
      for (const definition of TRANSLATABLE) {
        const rows = this.db
          .prepare(`SELECT ${definition.idColumn} AS row_id, ${definition.column} AS value
                    FROM ${definition.table}`)
          .all() as { row_id: string | number; value: string }[];

        for (const row of rows) {
          const stored = fromDbJson<Localised>(row.value, {});
          if (!(locale in stored)) continue;

          const localised: Record<string, string> = { ...stored };
          delete localised[locale];
          const where = definition.singleton ? 'singleton = 1' : `${definition.idColumn} = ?`;
          const params = definition.singleton ? [] : [String(row.row_id)];
          this.db
            .prepare(`UPDATE ${definition.table} SET ${definition.column} = ? WHERE ${where}`)
            .run(toDbJson(localised), ...params);
          cleared += 1;
        }
      }
    });
    purge.immediate();
    return cleared;
  }

  /** How much of the menu exists in a locale — shown next to each language. */
  coverage(locale: string, sourceLocale: string): { total: number; translated: number } {
    const entries = this.collect(sourceLocale, locale);
    return {
      total: entries.length,
      translated: entries.filter((entry) => entry.current !== '').length,
    };
  }

  /** The kinds a translator will meet, for the console's summary. */
  static get translatableKinds(): readonly string[] {
    return [...new Set(TRANSLATABLE.map((definition) => definition.kind))];
  }
}

/* --------------------------------------------------------------- bundles */

export const TRANSLATION_BUNDLE_SCHEMA = 'qserve.translation.bundle.v1';

/**
 * What the owner copies out and pastes back: one file holding both halves of a
 * language. Splitting them would double the work and invite a half-translated
 * restaurant where the buttons are French and the food is not.
 */
export interface TranslationBundle {
  readonly $schema: string;
  readonly locale: string;
  readonly name: string;
  readonly englishName: string;
  readonly direction: 'ltr' | 'rtl';
  readonly fallback: string | null;
  /** Where the untranslated text came from, so a re-export can match it. */
  readonly sourceLocale: string;
  /** Interface strings — the dotted keys the shipped packs use. */
  readonly ui: Record<string, string>;
  /** The restaurant's own text — `kind:id:field`. */
  readonly content: Record<string, string>;
}

export function parseTranslationBundle(input: unknown): TranslationBundle {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw validationError('the pasted text is not a JSON object', { field: 'bundle' });
  }
  const bundle = input as Partial<TranslationBundle>;

  if (bundle.$schema !== TRANSLATION_BUNDLE_SCHEMA) {
    throw validationError(
      `this file is not a QServe translation bundle (expected $schema "${TRANSLATION_BUNDLE_SCHEMA}")`,
      { field: 'bundle.$schema' },
    );
  }
  if (bundle.direction !== 'ltr' && bundle.direction !== 'rtl') {
    throw validationError('direction must be "ltr" or "rtl"', { field: 'bundle.direction' });
  }

  const asStrings = (value: unknown, field: string): Record<string, string> => {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw validationError(`"${field}" must be an object of key → text`, { field });
    }
    const out: Record<string, string> = {};
    for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
      if (typeof text !== 'string') {
        throw validationError(`"${field}.${key}" must be text`, { field });
      }
      out[key] = text;
    }
    return out;
  };

  return {
    $schema: TRANSLATION_BUNDLE_SCHEMA,
    locale: String(bundle.locale ?? '').trim(),
    name: String(bundle.name ?? '').trim(),
    englishName: String(bundle.englishName ?? '').trim(),
    direction: bundle.direction,
    fallback: bundle.fallback ? String(bundle.fallback) : null,
    sourceLocale: String(bundle.sourceLocale ?? 'en'),
    ui: asStrings(bundle.ui, 'ui'),
    content: asStrings(bundle.content, 'content'),
  };
}
