/**
 * Languages and themes a restaurant authored for itself.
 *
 * The vendor ships packs as files under `locales/` and `themes/`. These are the
 * restaurant's own, so they live in the restaurant's database and travel in its
 * backups — a restaurant that translated its entire menu into French must not
 * lose that work when the computer is replaced.
 *
 * A restaurant pack with the same code as a shipped one is merged *over* it, so
 * an owner can also correct a shipped wording without waiting for a release.
 */

import type { Db } from '@qserve/db';
import { fromDbJson, nowIso, toDbJson } from '@qserve/db';
import type { TextDirection, TokenTree } from '@qserve/shared';

export interface CustomLocaleRow {
  locale: string;
  name: string;
  english_name: string;
  direction: TextDirection;
  fallback: string | null;
  strings_json: string;
  created_at: string;
  updated_at: string;
}

export interface CustomThemeRow {
  id: string;
  name: string;
  color_scheme: 'light' | 'dark';
  tokens_json: string;
  created_at: string;
  updated_at: string;
}

export class PackRepository {
  constructor(private readonly db: Db) {}

  /* -------------------------------------------------------------- locales */

  listLocales(): CustomLocaleRow[] {
    return this.db
      .prepare('SELECT * FROM custom_locales ORDER BY locale')
      .all() as CustomLocaleRow[];
  }

  getLocale(locale: string): CustomLocaleRow | undefined {
    return this.db.prepare('SELECT * FROM custom_locales WHERE locale = ?').get(locale) as
      | CustomLocaleRow
      | undefined;
  }

  saveLocale(input: {
    locale: string;
    name: string;
    englishName: string;
    direction: TextDirection;
    fallback: string | null;
    strings: Readonly<Record<string, string>>;
  }): CustomLocaleRow {
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO custom_locales
          (locale, name, english_name, direction, fallback, strings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(locale) DO UPDATE SET
          name = excluded.name,
          english_name = excluded.english_name,
          direction = excluded.direction,
          fallback = excluded.fallback,
          strings_json = excluded.strings_json,
          updated_at = excluded.updated_at
      `)
      .run(
        input.locale, input.name, input.englishName, input.direction,
        input.fallback, toDbJson(input.strings), at, at,
      );
    return this.getLocale(input.locale)!;
  }

  deleteLocale(locale: string): void {
    this.db.prepare('DELETE FROM custom_locales WHERE locale = ?').run(locale);
  }

  localeStrings(row: CustomLocaleRow): Record<string, string> {
    return fromDbJson<Record<string, string>>(row.strings_json, {});
  }

  /* --------------------------------------------------------------- themes */

  listThemes(): CustomThemeRow[] {
    return this.db.prepare('SELECT * FROM custom_themes ORDER BY id').all() as CustomThemeRow[];
  }

  getTheme(id: string): CustomThemeRow | undefined {
    return this.db.prepare('SELECT * FROM custom_themes WHERE id = ?').get(id) as
      | CustomThemeRow
      | undefined;
  }

  saveTheme(input: {
    id: string;
    name: string;
    colorScheme: 'light' | 'dark';
    tokens: TokenTree;
  }): CustomThemeRow {
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO custom_themes (id, name, color_scheme, tokens_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          color_scheme = excluded.color_scheme,
          tokens_json = excluded.tokens_json,
          updated_at = excluded.updated_at
      `)
      .run(input.id, input.name, input.colorScheme, toDbJson(input.tokens), at, at);
    return this.getTheme(input.id)!;
  }

  deleteTheme(id: string): void {
    this.db.prepare('DELETE FROM custom_themes WHERE id = ?').run(id);
  }

  themeTokens(row: CustomThemeRow): TokenTree {
    return fromDbJson<TokenTree>(row.tokens_json, {});
  }
}
