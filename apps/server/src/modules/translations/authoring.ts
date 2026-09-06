/**
 * Language and theme authoring for the restaurant owner.
 *
 * The whole feature is one loop, and it is deliberately low-tech:
 *
 *     1. Pick a starting point — the empty key template, or an existing language.
 *     2. Copy the JSON.
 *     3. Translate it anywhere at all.
 *     4. Paste it back, name the language, choose its direction, save.
 *
 * Nothing here calls a translation service, and nothing needs an account or an
 * API key. That is the point: the restaurant owns the result, the work can be
 * given to a member of staff or a translator, and the only step that touches
 * the internet is the one happening outside this program.
 *
 * A bundle carries *both* halves of a language — the interface strings and the
 * restaurant's own menu text. Splitting them would double the work and invite
 * the half-translated restaurant where the buttons are French and the food is
 * still English.
 */

import {
  conflict, hasBlockingIssues, LOCALE_CODE_PATTERN, LOCALE_SCHEMA_ID, THEME_ID_PATTERN,
  THEME_SCHEMA_ID, validateLocalePack, validateThemePack, validationError,
  type Actor, type TextDirection, type ThemePack, type TokenTree,
} from '@qserve/shared';
import type { AuditRepository } from '../../core/repositories/audit.js';
import type { PackRepository } from '../../core/repositories/packs.js';
import type { SettingsRepository } from '../../core/repositories/settings.js';
import type { ThemeService } from '../themes/service.js';
import {
  ContentTranslationRepository, parseTranslationBundle, TRANSLATION_BUNDLE_SCHEMA,
  type ImportOutcome, type TranslationBundle,
} from './content.js';
import { REFERENCE_LOCALE, type TranslationService } from './service.js';

/** Where the starting values in an exported bundle come from. */
export type ExportMode =
  /** Every value blank — the template for a language nobody has started. */
  | 'template'
  /** The source language's text, for a translator to work from. */
  | 'source'
  /** What the target language already has, for correcting an existing one. */
  | 'current';

export interface LanguageSummary {
  readonly locale: string;
  readonly name: string;
  readonly englishName: string;
  readonly direction: TextDirection;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  /** Shipped with the app (cannot be deleted) or authored by this restaurant. */
  readonly shipped: boolean;
  readonly authored: boolean;
  readonly coverage: {
    readonly uiTotal: number;
    readonly uiTranslated: number;
    readonly contentTotal: number;
    readonly contentTranslated: number;
    readonly percent: number;
  };
}

export class PackAuthoringService {
  constructor(
    private readonly packs: PackRepository,
    private readonly content: ContentTranslationRepository,
    private readonly translations: TranslationService,
    private readonly themes: ThemeService,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditRepository,
  ) {}

  private defaultLocale(): string {
    return this.settings.profile()?.defaultLocale ?? REFERENCE_LOCALE;
  }

  /* ------------------------------------------------------------ languages */

  listLanguages(): LanguageSummary[] {
    const profile = this.settings.profile();
    const enabled = profile?.enabledLocales ?? [REFERENCE_LOCALE];
    const source = this.defaultLocale();
    const uiKeys = this.translations.referenceKeys();
    const authoredCodes = new Set(this.packs.listLocales().map((row) => row.locale));

    return this.translations.summaries(enabled).map((summary) => {
      const pack = this.translations.pack(summary.locale);
      const uiTranslated = uiKeys.filter((key) => (pack.strings[key] ?? '') !== '').length;
      const contentCoverage = this.content.coverage(summary.locale, source);

      const total = uiKeys.length + contentCoverage.total;
      const done = uiTranslated + contentCoverage.translated;

      return {
        ...summary,
        isDefault: summary.locale === profile?.defaultLocale,
        shipped: this.translations.isShipped(summary.locale),
        authored: authoredCodes.has(summary.locale),
        coverage: {
          uiTotal: uiKeys.length,
          uiTranslated,
          contentTotal: contentCoverage.total,
          contentTranslated: contentCoverage.translated,
          percent: total === 0 ? 100 : Math.round((done / total) * 100),
        },
      };
    });
  }

  /**
   * Build the JSON the owner copies. `targetLocale` may be a language that does
   * not exist yet — that is the normal case for adding one.
   */
  exportBundle(input: {
    targetLocale: string;
    sourceLocale?: string;
    mode: ExportMode;
    name?: string;
    englishName?: string;
    direction?: TextDirection;
  }): TranslationBundle {
    const sourceLocale = input.sourceLocale ?? this.defaultLocale();
    if (!this.translations.has(sourceLocale)) {
      throw validationError('the language to translate from is not installed', {
        field: 'sourceLocale',
      });
    }

    const sourcePack = this.translations.resolved(sourceLocale);
    const existing = this.translations.has(input.targetLocale)
      ? this.translations.pack(input.targetLocale)
      : null;

    const ui: Record<string, string> = {};
    for (const key of this.translations.referenceKeys()) {
      ui[key] = input.mode === 'template'
        ? ''
        : input.mode === 'current'
          ? existing?.strings[key] ?? ''
          : sourcePack.strings[key] ?? '';
    }

    const content: Record<string, string> = {};
    for (const entry of this.content.collect(sourceLocale, input.targetLocale)) {
      content[entry.key] = input.mode === 'template'
        ? ''
        : input.mode === 'current'
          ? entry.current
          : entry.source;
    }

    return {
      $schema: TRANSLATION_BUNDLE_SCHEMA,
      locale: input.targetLocale,
      name: input.name ?? existing?.name ?? '',
      englishName: input.englishName ?? existing?.englishName ?? '',
      direction: input.direction ?? (existing?.direction as TextDirection) ?? 'ltr',
      fallback: existing?.fallback ?? sourceLocale,
      sourceLocale,
      ui,
      content,
    };
  }

  /**
   * Save a pasted bundle. Validates the interface half against the same schema
   * the shipped packs must satisfy, so a restaurant cannot paste something that
   * would break a cashier screen mid-service.
   */
  importBundle(input: {
    raw: unknown;
    /** Fields the console collected separately, which override the bundle. */
    override?: { locale?: string; name?: string; englishName?: string; direction?: TextDirection };
    enable: boolean;
    actor: Actor;
    clientIp: string | null;
  }): { locale: string; ui: number; content: ImportOutcome } {
    const bundle = parseTranslationBundle(input.raw);

    const locale = (input.override?.locale ?? bundle.locale).trim();
    const name = (input.override?.name ?? bundle.name).trim();
    const englishName = (input.override?.englishName ?? bundle.englishName).trim() || name;
    const direction = input.override?.direction ?? bundle.direction;

    if (!LOCALE_CODE_PATTERN.test(locale)) {
      throw validationError(
        'the language code must look like "fr", "pt-BR" or "zh-Hans"',
        { field: 'locale' },
      );
    }
    if (name === '') {
      throw validationError('the language needs a name', { field: 'name' });
    }

    // The interface half must satisfy the shipped-pack contract. Only the keys
    // actually filled in are checked, so a partial translation is allowed —
    // missing keys fall back, which is far better than refusing the paste.
    const filledUi = Object.fromEntries(
      Object.entries(bundle.ui).filter(([, value]) => value.trim() !== ''),
    );
    const issues = validateLocalePack({
      $schema: LOCALE_SCHEMA_ID,
      locale,
      name,
      englishName,
      direction,
      fallback: bundle.fallback ?? REFERENCE_LOCALE,
      strings: filledUi,
    });
    if (hasBlockingIssues(issues)) {
      const first = issues.find((issue) => issue.severity === 'error');
      throw validationError(
        `the interface half of this bundle is not valid: ${first?.kind} ${first?.key ?? ''} — ${first?.detail}`,
        { field: 'ui', issues: issues.slice(0, 10) },
      );
    }

    const before = this.packs.getLocale(locale);

    // Merge, exactly as the menu half does. A paste is often partial — a
    // correction to one wording, or a translation finished in two sittings —
    // and replacing the pack outright would silently undo the earlier work.
    const merged = { ...(before ? this.packs.localeStrings(before) : {}), ...filledUi };

    this.packs.saveLocale({
      locale,
      name,
      englishName,
      direction,
      fallback: bundle.fallback ?? REFERENCE_LOCALE,
      strings: merged,
    });
    const contentOutcome = this.content.apply(locale, bundle.content);
    this.translations.refreshAuthored();

    if (input.enable) this.enableLocale(locale);

    this.audit.record({
      action: before ? 'language.updated' : 'language.created',
      actor: input.actor,
      entityType: 'language',
      entityId: locale,
      before: before ? { name: before.name, direction: before.direction } : undefined,
      after: { name, englishName, direction },
      detail: {
        uiKeys: Object.keys(filledUi).length,
        contentApplied: contentOutcome.applied,
        contentSkipped: contentOutcome.skippedUnknown.length,
      },
      clientIp: input.clientIp,
    });

    return { locale, ui: Object.keys(filledUi).length, content: contentOutcome };
  }

  private enableLocale(locale: string): void {
    const profile = this.settings.profile();
    if (!profile || profile.enabledLocales.includes(locale)) return;
    this.settings.updateRestaurant({ enabledLocales: [...profile.enabledLocales, locale] });
  }

  deleteLanguage(input: { locale: string; actor: Actor; clientIp: string | null }): {
    contentCleared: number;
  } {
    const row = this.packs.getLocale(input.locale);
    if (!row) {
      throw conflict('only a language this restaurant added can be removed', {
        locale: input.locale,
      });
    }
    const profile = this.settings.profile();
    if (profile?.defaultLocale === input.locale) {
      throw conflict('choose a different default language before removing this one');
    }

    this.packs.deleteLocale(input.locale);
    // Leaving the translations behind would show a language that is no longer
    // listed, so the menu text goes with it.
    const contentCleared = this.content.purge(input.locale);
    this.translations.refreshAuthored();

    if (profile) {
      this.settings.updateRestaurant({
        enabledLocales: profile.enabledLocales.filter((entry) => entry !== input.locale),
      });
    }

    this.audit.record({
      action: 'language.deleted',
      actor: input.actor,
      entityType: 'language',
      entityId: input.locale,
      before: { name: row.name, direction: row.direction },
      detail: { contentCleared },
      clientIp: input.clientIp,
    });

    return { contentCleared };
  }

  /* --------------------------------------------------------------- themes */

  /** The theme JSON an owner copies, ready to edit and paste back. */
  exportTheme(id: string): ThemePack {
    return this.themes.get(id);
  }

  importTheme(input: {
    raw: unknown;
    override?: { id?: string; name?: string };
    actor: Actor;
    clientIp: string | null;
  }): { id: string } {
    if (typeof input.raw !== 'object' || input.raw === null || Array.isArray(input.raw)) {
      throw validationError('the pasted text is not a JSON object', { field: 'theme' });
    }
    const pasted = input.raw as Partial<ThemePack>;

    const id = (input.override?.id ?? pasted.id ?? '').trim();
    const name = (input.override?.name ?? pasted.name ?? '').trim();

    if (!THEME_ID_PATTERN.test(id)) {
      throw validationError(
        'the theme id must be lower-case letters, digits and dashes',
        { field: 'id' },
      );
    }
    if (name === '') throw validationError('the theme needs a name', { field: 'name' });

    const candidate: ThemePack = {
      $schema: THEME_SCHEMA_ID,
      id,
      name,
      colorScheme: pasted.colorScheme === 'dark' ? 'dark' : 'light',
      tokens: (pasted.tokens ?? {}) as TokenTree,
    };

    // A theme missing a token would render some screen unreadably, so the full
    // contract is enforced here exactly as it is for a shipped theme.
    const issues = validateThemePack(candidate);
    if (issues.length > 0) {
      throw validationError(
        `this theme is missing or misusing ${issues.length} token(s): ` +
        issues.slice(0, 3).map((issue) => `${issue.token ?? ''} ${issue.detail}`).join('; '),
        { field: 'tokens', issues: issues.slice(0, 20) },
      );
    }

    const before = this.packs.getTheme(id);
    this.packs.saveTheme({
      id, name, colorScheme: candidate.colorScheme, tokens: candidate.tokens,
    });
    this.themes.refreshAuthored();

    this.audit.record({
      action: before ? 'theme.updated' : 'theme.created',
      actor: input.actor,
      entityType: 'theme',
      entityId: id,
      after: { name, colorScheme: candidate.colorScheme },
      clientIp: input.clientIp,
    });

    return { id };
  }

  deleteTheme(input: { id: string; actor: Actor; clientIp: string | null }): void {
    const row = this.packs.getTheme(input.id);
    if (!row) {
      throw conflict('only a theme this restaurant added can be removed', { id: input.id });
    }
    if (this.settings.profile()?.themeId === input.id) {
      throw conflict('choose a different theme before removing this one');
    }

    this.packs.deleteTheme(input.id);
    this.themes.refreshAuthored();

    this.audit.record({
      action: 'theme.deleted',
      actor: input.actor,
      entityType: 'theme',
      entityId: input.id,
      before: { name: row.name },
      clientIp: input.clientIp,
    });
  }

  listThemes(): {
    id: string; name: string; colorScheme: string; active: boolean;
    shipped: boolean; authored: boolean;
  }[] {
    const activeId = this.settings.profile()?.themeId ?? 'light';
    const authoredIds = new Set(this.packs.listThemes().map((row) => row.id));

    return this.themes.summaries(activeId).map((summary) => ({
      ...summary,
      shipped: this.themes.isShipped(summary.id),
      authored: authoredIds.has(summary.id),
    }));
  }
}
