/**
 * Authoring the packs that *ship with the product* (spec §30, §32, §33).
 *
 * A restaurant adds a language for itself, and that language lives in its own
 * database. The developer adds a language to QServe, and that language is a
 * file in `locales/` — every installation gets it, and it becomes the thing
 * restaurants translate *from*.
 *
 * Both are the same workflow: copy the JSON, translate it, paste it back. The
 * differences are that this one writes a file rather than a row, and that it
 * validates strictly — a shipped pack missing a key would leave that key
 * untranslated in every restaurant on earth, so it is refused rather than
 * accepted with a warning.
 *
 * Available only in developer mode, which no packaged build turns on.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  conflict, hasBlockingIssues, LOCALE_CODE_PATTERN, LOCALE_SCHEMA_ID, THEME_ID_PATTERN,
  THEME_SCHEMA_ID, validateLocalePack, validateThemePack, validationError,
  type Actor, type LocaleIssue, type LocalePack, type TextDirection,
  type ThemeIssue, type ThemePack, type TokenTree,
} from '@qserve/shared';
import type { AuditRepository } from '../../core/repositories/audit.js';
import { REFERENCE_LOCALE, type TranslationService } from './service.js';
import type { ThemeService } from '../themes/service.js';

export interface ShippedPackDirs {
  readonly localesDir: string;
  readonly themesDir: string;
}

export class ShippedPackService {
  constructor(
    private readonly dirs: ShippedPackDirs,
    private readonly translations: TranslationService,
    private readonly themes: ThemeService,
    private readonly audit: AuditRepository,
  ) {}

  /* ------------------------------------------------------------ languages */

  /**
   * The file to copy. `from` decides what the values hold: another language's
   * text to translate over, or nothing at all to start from the key list.
   */
  localeTemplate(input: {
    locale: string;
    from?: string | null;
    name?: string;
    englishName?: string;
    direction?: TextDirection;
  }): LocalePack {
    const reference = this.translations.pack(REFERENCE_LOCALE);
    const source = input.from ? this.translations.resolved(input.from) : null;
    const existing = this.translations.has(input.locale)
      ? this.translations.pack(input.locale)
      : null;

    const strings: Record<string, string> = {};
    for (const key of Object.keys(reference.strings).sort()) {
      strings[key] = source?.strings[key] ?? '';
    }

    return {
      $schema: LOCALE_SCHEMA_ID,
      locale: input.locale,
      name: input.name || existing?.name || '',
      englishName: input.englishName || existing?.englishName || '',
      direction: input.direction ?? (existing?.direction as TextDirection) ?? 'ltr',
      fallback: existing?.fallback ?? REFERENCE_LOCALE,
      strings,
    };
  }

  /** Check a pasted pack without writing it, so the console can show why. */
  checkLocale(raw: unknown): { pack: LocalePack; issues: LocaleIssue[] } {
    const pack = asObject(raw, 'locale pack') as unknown as LocalePack;

    if (!LOCALE_CODE_PATTERN.test(String(pack.locale ?? ''))) {
      throw validationError(
        'the language code must look like "fr", "pt-BR" or "zh-Hans"',
        { field: 'locale' },
      );
    }
    if (!String(pack.name ?? '').trim()) {
      throw validationError('the language needs a name', { field: 'name' });
    }

    // Checked against the reference, and strictly: a gap in a shipped pack is
    // a gap in every installation.
    const reference = this.translations.pack(REFERENCE_LOCALE);
    const issues = pack.locale === REFERENCE_LOCALE
      ? validateLocalePack(pack)
      : validateLocalePack(pack, { reference, strictCoverage: true });

    return { pack, issues };
  }

  installLocale(input: { raw: unknown; actor: Actor; clientIp: string | null }): {
    locale: string;
    file: string;
    keys: number;
  } {
    const { pack, issues } = this.checkLocale(input.raw);
    if (hasBlockingIssues(issues)) {
      const first = issues.find((issue) => issue.severity === 'error');
      throw validationError(
        `this pack is not ready to ship: ${issues.filter((i) => i.severity === 'error').length}` +
        ` error(s), first is ${first?.kind} ${first?.key ?? ''} — ${first?.detail}`,
        { field: 'pack', issues: issues.slice(0, 20) },
      );
    }

    mkdirSync(this.dirs.localesDir, { recursive: true });
    const file = join(this.dirs.localesDir, `${pack.locale}.json`);
    writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');

    // Reload from disk so the new language is live for every terminal at once.
    this.translations.load();

    this.audit.record({
      action: 'developer.locale_installed',
      actor: input.actor,
      entityType: 'shipped_locale',
      entityId: pack.locale,
      after: { name: pack.name, direction: pack.direction },
      detail: { keys: Object.keys(pack.strings).length },
      clientIp: input.clientIp,
    });

    return { locale: pack.locale, file, keys: Object.keys(pack.strings).length };
  }

  removeLocale(input: { locale: string; actor: Actor; clientIp: string | null }): void {
    if (input.locale === REFERENCE_LOCALE) {
      throw conflict('the reference language cannot be removed; every other pack is checked against it');
    }
    if (!this.translations.isShipped(input.locale)) {
      throw conflict('that language is not a shipped pack', { locale: input.locale });
    }

    rmSync(join(this.dirs.localesDir, `${input.locale}.json`), { force: true });
    this.translations.load();

    this.audit.record({
      action: 'developer.locale_removed',
      actor: input.actor,
      entityType: 'shipped_locale',
      entityId: input.locale,
      clientIp: input.clientIp,
    });
  }

  /* --------------------------------------------------------------- themes */

  themeTemplate(input: { id: string; from?: string | null }): ThemePack {
    const base = this.themes.get(input.from || 'light');
    return {
      $schema: THEME_SCHEMA_ID,
      id: input.id,
      name: this.themes.has(input.id) ? this.themes.get(input.id).name : '',
      colorScheme: base.colorScheme,
      tokens: base.tokens,
    };
  }

  checkTheme(raw: unknown): { pack: ThemePack; issues: ThemeIssue[] } {
    const pasted = asObject(raw, 'theme pack') as unknown as Partial<ThemePack>;
    const id = String(pasted.id ?? '').trim();

    if (!THEME_ID_PATTERN.test(id)) {
      throw validationError('the theme id must be lower-case letters, digits and dashes', {
        field: 'id',
      });
    }
    if (!String(pasted.name ?? '').trim()) {
      throw validationError('the theme needs a name', { field: 'name' });
    }

    const pack: ThemePack = {
      $schema: THEME_SCHEMA_ID,
      id,
      name: String(pasted.name).trim(),
      colorScheme: pasted.colorScheme === 'dark' ? 'dark' : 'light',
      tokens: (pasted.tokens ?? {}) as TokenTree,
    };
    return { pack, issues: validateThemePack(pack) };
  }

  installTheme(input: { raw: unknown; actor: Actor; clientIp: string | null }): {
    id: string;
    file: string;
  } {
    const { pack, issues } = this.checkTheme(input.raw);
    if (issues.length > 0) {
      throw validationError(
        `this theme is missing or misusing ${issues.length} token(s): ` +
        issues.slice(0, 3).map((issue) => `${issue.token ?? ''} ${issue.detail}`).join('; '),
        { field: 'tokens', issues: issues.slice(0, 20) },
      );
    }

    mkdirSync(this.dirs.themesDir, { recursive: true });
    const file = join(this.dirs.themesDir, `${pack.id}.json`);
    writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    this.themes.load();

    this.audit.record({
      action: 'developer.theme_installed',
      actor: input.actor,
      entityType: 'shipped_theme',
      entityId: pack.id,
      after: { name: pack.name, colorScheme: pack.colorScheme },
      clientIp: input.clientIp,
    });

    return { id: pack.id, file };
  }

  removeTheme(input: { id: string; actor: Actor; clientIp: string | null }): void {
    if (!this.themes.isShipped(input.id)) {
      throw conflict('that theme is not a shipped pack', { id: input.id });
    }
    rmSync(join(this.dirs.themesDir, `${input.id}.json`), { force: true });
    this.themes.load();

    this.audit.record({
      action: 'developer.theme_removed',
      actor: input.actor,
      entityType: 'shipped_theme',
      entityId: input.id,
      clientIp: input.clientIp,
    });
  }

  /* ---------------------------------------------------------- diagnostics */

  /** What is on disk, what loaded, and what was rejected and why. */
  overview(): {
    localesDir: string;
    themesDir: string;
    files: { locales: string[]; themes: string[] };
    locales: ReturnType<TranslationService['diagnostics']>;
    themes: ReturnType<ThemeService['diagnostics']>;
    referenceKeys: number;
  } {
    const list = (dir: string): string[] => {
      try {
        return readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
      } catch {
        return [];
      }
    };

    return {
      localesDir: this.dirs.localesDir,
      themesDir: this.dirs.themesDir,
      files: { locales: list(this.dirs.localesDir), themes: list(this.dirs.themesDir) },
      locales: this.translations.diagnostics(),
      themes: this.themes.diagnostics(),
      referenceKeys: this.translations.referenceKeys().length,
    };
  }
}

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw validationError(`the pasted text is not a JSON object (expected a ${what})`, {
      field: 'pack',
    });
  }
  return raw as Record<string, unknown>;
}
