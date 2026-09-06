/**
 * Language packs (spec §32).
 *
 * Adding a language is adding a file to `locales/`. The server discovers packs
 * at boot, validates each against the schema, and serves them to every terminal.
 * No core code changes, no rebuild, no redeploy — which is exactly the property
 * the spec asks for.
 *
 * Validation is not optional: a pack with an invalid key, a duplicate key or a
 * placeholder mismatch is rejected and reported, so a bad translation cannot
 * silently break a cashier screen mid-service.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  hasBlockingIssues, interpolate, notFound, validateLocalePack,
  type LocaleIssue, type LocalePack, type LocaleSummary, type TextDirection,
} from '@qserve/shared';
import type { PackRepository } from '../../core/repositories/packs.js';

/** The pack every other pack is validated against, and the last-resort fallback. */
export const REFERENCE_LOCALE = 'en';

export interface LoadedLocale {
  readonly pack: LocalePack;
  readonly issues: readonly LocaleIssue[];
}

export class TranslationService {
  /** Packs shipped by the vendor, read from disk. */
  private filePacks = new Map<string, LocalePack>();
  /** The effective set: shipped packs with the restaurant's own merged over. */
  private packs = new Map<string, LocalePack>();
  private issues = new Map<string, LocaleIssue[]>();
  private rejected = new Map<string, LocaleIssue[]>();
  private authored: PackRepository | null = null;

  constructor(
    private readonly localesDir: string,
    private readonly onWarning: (message: string) => void = () => {},
  ) {}

  /**
   * Connect the restaurant's own languages. Set after construction because the
   * database is opened before the pack repository exists.
   */
  useAuthoredPacks(repository: PackRepository): void {
    this.authored = repository;
    this.mergeAuthored();
  }

  /** Read and validate every `*.json` in the locales directory. */
  load(): void {
    this.filePacks = new Map();
    this.issues = new Map();
    this.rejected = new Map();

    let files: string[];
    try {
      files = readdirSync(this.localesDir).filter((name) => name.endsWith('.json'));
    } catch {
      this.onWarning(`no locales directory at ${this.localesDir}; falling back to keys`);
      return;
    }

    // The reference pack has to be validated first: everything else is checked
    // for coverage against it.
    const ordered = files.sort((a, b) =>
      a === `${REFERENCE_LOCALE}.json` ? -1 : b === `${REFERENCE_LOCALE}.json` ? 1 : a.localeCompare(b));

    for (const file of ordered) {
      const path = join(this.localesDir, file);
      if (!statSync(path).isFile()) continue;

      const expectedLocale = basename(file, '.json');
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (error) {
        this.onWarning(`could not read locale ${file}: ${String(error)}`);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        this.rejected.set(expectedLocale, [{
          kind: 'SCHEMA', detail: `invalid JSON: ${String(error)}`, severity: 'error',
        }]);
        this.onWarning(`locale ${file} is not valid JSON and was not loaded`);
        continue;
      }

      const reference = this.filePacks.get(REFERENCE_LOCALE);
      const issues = validateLocalePack(parsed, {
        rawSource: raw,
        ...(reference && expectedLocale !== REFERENCE_LOCALE ? { reference } : {}),
      });

      const pack = parsed as LocalePack;
      if (pack.locale !== expectedLocale) {
        issues.push({
          kind: 'SCHEMA',
          detail: `locale "${pack.locale}" does not match the file name "${file}"`,
          severity: 'error',
        });
      }

      if (hasBlockingIssues(issues)) {
        this.rejected.set(expectedLocale, issues);
        this.onWarning(
          `locale ${file} was rejected: ${issues.filter((i) => i.severity === 'error').length} error(s)`,
        );
        continue;
      }

      this.filePacks.set(pack.locale, pack);
      this.issues.set(pack.locale, issues);

      const missing = issues.filter((issue) => issue.kind === 'MISSING_KEY').length;
      if (missing > 0) {
        this.onWarning(`locale ${pack.locale} is missing ${missing} key(s); falling back for those`);
      }
    }

    this.mergeAuthored();
  }

  /**
   * Recompute the effective set. A restaurant pack for a shipped code overrides
   * only the keys it defines, so correcting one wording never costs the rest of
   * the translation.
   */
  private mergeAuthored(): void {
    this.packs = new Map(this.filePacks);
    if (!this.authored) return;

    for (const row of this.authored.listLocales()) {
      const base = this.filePacks.get(row.locale);
      this.packs.set(row.locale, {
        $schema: 'qserve.locale.v1',
        locale: row.locale,
        name: row.name,
        englishName: row.english_name,
        direction: row.direction,
        fallback: row.fallback ?? REFERENCE_LOCALE,
        strings: { ...(base?.strings ?? {}), ...this.authored.localeStrings(row) },
      });
    }
  }

  /** Call after the restaurant adds, edits or deletes one of its languages. */
  refreshAuthored(): void {
    this.mergeAuthored();
  }

  /** True when this language came from a file rather than from the restaurant. */
  isShipped(locale: string): boolean {
    return this.filePacks.has(locale);
  }

  /** The reference pack's keys — the empty template an owner starts from. */
  referenceKeys(): string[] {
    return Object.keys(this.filePacks.get(REFERENCE_LOCALE)?.strings ?? {}).sort();
  }

  get available(): string[] {
    return [...this.packs.keys()].sort();
  }

  has(locale: string): boolean {
    return this.packs.has(locale);
  }

  pack(locale: string): LocalePack {
    const pack = this.packs.get(locale);
    if (!pack) throw notFound('locale', locale);
    return pack;
  }

  /**
   * A pack merged with its fallback chain, so a terminal receives one complete
   * dictionary and never has to implement fallback itself.
   */
  resolved(locale: string): LocalePack {
    const pack = this.pack(locale);
    const strings: Record<string, string> = {};

    const chain: LocalePack[] = [];
    let current: LocalePack | undefined = pack;
    const seen = new Set<string>();
    while (current && !seen.has(current.locale)) {
      seen.add(current.locale);
      chain.push(current);
      current = current.fallback ? this.packs.get(current.fallback) : undefined;
    }
    const reference = this.packs.get(REFERENCE_LOCALE);
    if (reference && !seen.has(REFERENCE_LOCALE)) chain.push(reference);

    // Later packs fill gaps left by earlier ones.
    for (const entry of chain.reverse()) Object.assign(strings, entry.strings);
    return { ...pack, strings };
  }

  summaries(enabled: readonly string[]): LocaleSummary[] {
    return [...this.packs.values()].map((pack) => ({
      locale: pack.locale,
      name: pack.name,
      englishName: pack.englishName,
      direction: pack.direction as TextDirection,
      enabled: enabled.includes(pack.locale),
    }));
  }

  direction(locale: string): TextDirection {
    return (this.packs.get(locale)?.direction ?? 'ltr') as TextDirection;
  }

  /** Server-side translation, used for print documents and log messages. */
  translate(locale: string, key: string, params?: Record<string, unknown>): string {
    const pack = this.packs.get(locale) ?? this.packs.get(REFERENCE_LOCALE);
    const template = pack?.strings[key];
    if (template === undefined) {
      const fallback = this.packs.get(REFERENCE_LOCALE)?.strings[key];
      return fallback === undefined ? key : interpolate(fallback, params);
    }
    return interpolate(template, params);
  }

  /** Health report for the settings screen: what loaded, what did not, and why. */
  diagnostics(): {
    loaded: { locale: string; warnings: number }[];
    rejected: { locale: string; issues: LocaleIssue[] }[];
  } {
    return {
      loaded: [...this.issues.entries()].map(([locale, issues]) => ({
        locale, warnings: issues.length,
      })),
      rejected: [...this.rejected.entries()].map(([locale, issues]) => ({ locale, issues })),
    };
  }
}
