/**
 * Language pack format and validation (spec §32).
 *
 * Adding a language means adding one file that satisfies this schema. No core
 * code changes, no rebuild — the server discovers locale packs from disk at
 * boot and serves them to every terminal. See docs/EXTENDING.md.
 */

import { TextDirection } from './enums.js';

export const LOCALE_SCHEMA_ID = 'qserve.locale.v1';

/** Translation keys are dotted, lower-snake segments: `orders.action.accept`. */
export const TRANSLATION_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** BCP-47-ish: `ar`, `en`, `tr`, `pt-BR`, `zh-Hans`. */
export const LOCALE_CODE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface LocalePack {
  readonly $schema: string;
  /** Locale code, must equal the file's basename. */
  readonly locale: string;
  /** Endonym, shown in the language picker: "العربية". */
  readonly name: string;
  /** English name, for the vendor console: "Arabic". */
  readonly englishName: string;
  readonly direction: TextDirection;
  /** Locale used for keys this pack does not define. */
  readonly fallback: string | null;
  /** Intl locale used for numbers, currency and dates. Defaults to `locale`. */
  readonly formatLocale?: string;
  readonly strings: Readonly<Record<string, string>>;
}

export const LocaleIssueKind = {
  SCHEMA: 'SCHEMA',
  MISSING_KEY: 'MISSING_KEY',
  INVALID_KEY: 'INVALID_KEY',
  DUPLICATE_KEY: 'DUPLICATE_KEY',
  UNSUPPORTED_KEY: 'UNSUPPORTED_KEY',
  EMPTY_VALUE: 'EMPTY_VALUE',
  PLACEHOLDER_MISMATCH: 'PLACEHOLDER_MISMATCH',
} as const;
export type LocaleIssueKind = (typeof LocaleIssueKind)[keyof typeof LocaleIssueKind];

export interface LocaleIssue {
  readonly kind: LocaleIssueKind;
  readonly key?: string;
  readonly detail: string;
  /** MISSING_KEY on a non-reference locale is a warning, not a hard failure. */
  readonly severity: 'error' | 'warning';
}

/** `{name}` style placeholders, the only interpolation syntax we support. */
const PLACEHOLDER_PATTERN = /\{([a-z][a-z0-9_]*)\}/gi;

export function extractPlaceholders(value: string): Set<string> {
  const found = new Set<string>();
  for (const m of value.matchAll(PLACEHOLDER_PATTERN)) found.add(m[1]!);
  return found;
}

/**
 * JSON.parse silently keeps the last of duplicated keys, so duplicates are
 * detected by scanning the raw source. Pass `rawSource` when you have it.
 */
export function findDuplicateKeys(rawSource: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  // Only look inside the "strings" object; keys elsewhere are structural.
  const stringsAt = rawSource.indexOf('"strings"');
  const region = stringsAt === -1 ? rawSource : rawSource.slice(stringsAt);
  for (const m of region.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
    const key = m[1]!;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

export interface ValidateLocaleOptions {
  /**
   * The reference pack (normally `en`). Enables MISSING_KEY / UNSUPPORTED_KEY /
   * PLACEHOLDER_MISMATCH checks. Omit when validating the reference itself.
   */
  readonly reference?: LocalePack;
  readonly rawSource?: string;
  /** Fail on missing keys instead of warning. Used in CI for shipped locales. */
  readonly strictCoverage?: boolean;
}

export function validateLocalePack(
  candidate: unknown,
  options: ValidateLocaleOptions = {},
): LocaleIssue[] {
  const issues: LocaleIssue[] = [];
  const err = (kind: LocaleIssueKind, detail: string, key?: string): void => {
    issues.push(key === undefined ? { kind, detail, severity: 'error' }
                                  : { kind, detail, key, severity: 'error' });
  };

  if (typeof candidate !== 'object' || candidate === null) {
    err(LocaleIssueKind.SCHEMA, 'locale pack must be a JSON object');
    return issues;
  }
  const pack = candidate as Partial<LocalePack>;

  if (pack.$schema !== LOCALE_SCHEMA_ID) {
    err(LocaleIssueKind.SCHEMA, `$schema must be "${LOCALE_SCHEMA_ID}"`);
  }
  if (typeof pack.locale !== 'string' || !LOCALE_CODE_PATTERN.test(pack.locale)) {
    err(LocaleIssueKind.SCHEMA, `locale must match ${LOCALE_CODE_PATTERN}`);
  }
  if (typeof pack.name !== 'string' || pack.name.trim() === '') {
    err(LocaleIssueKind.SCHEMA, 'name (endonym) is required');
  }
  if (typeof pack.englishName !== 'string' || pack.englishName.trim() === '') {
    err(LocaleIssueKind.SCHEMA, 'englishName is required');
  }
  if (pack.direction !== TextDirection.LTR && pack.direction !== TextDirection.RTL) {
    err(LocaleIssueKind.SCHEMA, 'direction must be "ltr" or "rtl"');
  }
  if (pack.fallback !== null && typeof pack.fallback !== 'string') {
    err(LocaleIssueKind.SCHEMA, 'fallback must be a locale code or null');
  }
  if (typeof pack.strings !== 'object' || pack.strings === null) {
    err(LocaleIssueKind.SCHEMA, 'strings must be an object');
    return issues;
  }

  const strings = pack.strings as Record<string, unknown>;

  if (options.rawSource) {
    for (const dup of findDuplicateKeys(options.rawSource)) {
      err(LocaleIssueKind.DUPLICATE_KEY, `key "${dup}" appears more than once`, dup);
    }
  }

  for (const [key, value] of Object.entries(strings)) {
    if (!TRANSLATION_KEY_PATTERN.test(key)) {
      err(LocaleIssueKind.INVALID_KEY, `key does not match ${TRANSLATION_KEY_PATTERN}`, key);
      continue;
    }
    if (typeof value !== 'string') {
      err(LocaleIssueKind.SCHEMA, 'translation values must be strings', key);
      continue;
    }
    if (value.trim() === '') {
      err(LocaleIssueKind.EMPTY_VALUE, 'translation is empty', key);
    }
  }

  const reference = options.reference;
  if (reference) {
    const refKeys = Object.keys(reference.strings);
    for (const key of refKeys) {
      if (!(key in strings)) {
        issues.push({
          kind: LocaleIssueKind.MISSING_KEY,
          key,
          detail: `key present in ${reference.locale} but missing here`,
          severity: options.strictCoverage ? 'error' : 'warning',
        });
      }
    }
    const refSet = new Set(refKeys);
    for (const key of Object.keys(strings)) {
      if (!refSet.has(key)) {
        err(LocaleIssueKind.UNSUPPORTED_KEY,
            `key is not defined in the reference locale ${reference.locale}`, key);
        continue;
      }
      const refValue = reference.strings[key]!;
      const value = strings[key];
      if (typeof value !== 'string') continue;
      const expected = extractPlaceholders(refValue);
      const actual = extractPlaceholders(value);
      const missing = [...expected].filter((p) => !actual.has(p));
      const extra = [...actual].filter((p) => !expected.has(p));
      if (missing.length || extra.length) {
        err(LocaleIssueKind.PLACEHOLDER_MISMATCH,
            `placeholders differ (missing: ${missing.join(', ') || 'none'}; ` +
            `unexpected: ${extra.join(', ') || 'none'})`, key);
      }
    }
  }

  return issues;
}

export const hasBlockingIssues = (issues: readonly LocaleIssue[]): boolean =>
  issues.some((i) => i.severity === 'error');

/** Minimal ICU-free interpolation: `t('a.b', { name: 'Ali' })`. */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER_PATTERN, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole);
}
