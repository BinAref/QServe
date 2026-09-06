/**
 * Request-body validation.
 *
 * Small and explicit rather than schema-driven: every field a route accepts is
 * named in that route's code, so reading the route tells you exactly what it
 * will accept. Failures raise `AppError(VALIDATION)` carrying the field name,
 * which the front-ends turn into a localised message.
 */

import { validationError } from './errors.js';

export function asObject(value: unknown, what = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationError(`${what} must be a JSON object`, { field: what });
  }
  return value as Record<string, unknown>;
}

export interface StringRules {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
  /** Collapse surrounding whitespace before validating. Default true. */
  readonly trim?: boolean;
}

export function requireString(
  source: Record<string, unknown>,
  field: string,
  rules: StringRules = {},
): string {
  const raw = source[field];
  if (typeof raw !== 'string') {
    throw validationError(`"${field}" must be a string`, { field });
  }
  const value = rules.trim === false ? raw : raw.trim();

  const min = rules.min ?? 1;
  if (value.length < min) {
    throw validationError(`"${field}" must be at least ${min} characters`, { field, min });
  }
  const max = rules.max ?? 1000;
  if (value.length > max) {
    throw validationError(`"${field}" must be at most ${max} characters`, { field, max });
  }
  if (rules.pattern && !rules.pattern.test(value)) {
    throw validationError(`"${field}" is not in the expected format`, { field });
  }
  return value;
}

export function optionalString(
  source: Record<string, unknown>,
  field: string,
  rules: StringRules = {},
): string | null {
  const raw = source[field];
  if (raw === undefined || raw === null || raw === '') return null;
  return requireString(source, field, rules);
}

export function requireNumber(
  source: Record<string, unknown>,
  field: string,
  rules: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = source[field];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationError(`"${field}" must be a number`, { field });
  }
  if (rules.integer !== false && !Number.isInteger(value)) {
    throw validationError(`"${field}" must be a whole number`, { field });
  }
  if (rules.min !== undefined && value < rules.min) {
    throw validationError(`"${field}" must be at least ${rules.min}`, { field, min: rules.min });
  }
  if (rules.max !== undefined && value > rules.max) {
    throw validationError(`"${field}" must be at most ${rules.max}`, { field, max: rules.max });
  }
  return value;
}

export function optionalNumber(
  source: Record<string, unknown>,
  field: string,
  rules: { min?: number; max?: number; integer?: boolean } = {},
): number | null {
  const raw = source[field];
  if (raw === undefined || raw === null || raw === '') return null;
  return requireNumber(source, field, rules);
}

export function requireBoolean(source: Record<string, unknown>, field: string): boolean {
  const raw = source[field];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw validationError(`"${field}" must be a boolean`, { field });
}

export function optionalBoolean(
  source: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const raw = source[field];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return requireBoolean(source, field);
}

export function requireEnum<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const raw = source[field];
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw validationError(`"${field}" must be one of: ${allowed.join(', ')}`, {
      field, allowed: [...allowed],
    });
  }
  return raw as T;
}

export function optionalEnum<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = source[field];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return requireEnum(source, field, allowed);
}

export function requireArray(
  source: Record<string, unknown>,
  field: string,
  rules: { min?: number; max?: number } = {},
): unknown[] {
  const raw = source[field];
  if (!Array.isArray(raw)) {
    throw validationError(`"${field}" must be an array`, { field });
  }
  if (rules.min !== undefined && raw.length < rules.min) {
    throw validationError(`"${field}" needs at least ${rules.min} entries`, { field });
  }
  if (rules.max !== undefined && raw.length > rules.max) {
    throw validationError(`"${field}" accepts at most ${rules.max} entries`, { field });
  }
  return raw;
}

export function optionalArray(
  source: Record<string, unknown>,
  field: string,
  rules: { min?: number; max?: number } = {},
): unknown[] | null {
  if (source[field] === undefined || source[field] === null) return null;
  return requireArray(source, field, rules);
}

export function requireStringArray(
  source: Record<string, unknown>,
  field: string,
  rules: { min?: number; max?: number; itemMax?: number } = {},
): string[] {
  const raw = requireArray(source, field, rules);
  return raw.map((item, index) => {
    if (typeof item !== 'string') {
      throw validationError(`"${field}[${index}]" must be a string`, { field });
    }
    const value = item.trim();
    if (value.length > (rules.itemMax ?? 200)) {
      throw validationError(`"${field}[${index}]" is too long`, { field });
    }
    return value;
  });
}

/**
 * Localised text: `{ "en": "Burger", "ar": "برجر" }`. At least one non-empty
 * entry is required so a product can never be nameless in every language.
 */
export function requireLocalised(
  source: Record<string, unknown>,
  field: string,
  rules: { max?: number } = {},
): Record<string, string> {
  const raw = source[field];
  if (typeof raw === 'string') {
    // Convenience for single-language installations and integration clients.
    const value = raw.trim();
    if (value === '') throw validationError(`"${field}" cannot be empty`, { field });
    return { '*': value };
  }
  const object = asObject(raw, field);
  const out: Record<string, string> = {};
  for (const [locale, value] of Object.entries(object)) {
    if (typeof value !== 'string') {
      throw validationError(`"${field}.${locale}" must be a string`, { field });
    }
    const text = value.trim();
    if (text.length > (rules.max ?? 500)) {
      throw validationError(`"${field}.${locale}" is too long`, { field });
    }
    if (text !== '') out[locale] = text;
  }
  if (Object.keys(out).length === 0) {
    throw validationError(`"${field}" needs a value in at least one language`, { field });
  }
  return out;
}

export function optionalLocalised(
  source: Record<string, unknown>,
  field: string,
  rules: { max?: number } = {},
): Record<string, string> {
  const raw = source[field];
  if (raw === undefined || raw === null || raw === '') return {};

  // A form that renders one input per language sends `{}` when the operator
  // left every box blank — for an optional field (a description, say) that
  // means "none", not "invalid".
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const hasText = Object.values(raw as Record<string, unknown>)
      .some((value) => typeof value === 'string' && value.trim() !== '');
    if (!hasText) return {};
  }
  return requireLocalised(source, field, rules);
}

/**
 * Pick the best string for a viewer: their locale, then the restaurant default,
 * then the wildcard written by single-language installations, then anything.
 */
export function pickLocalised(
  value: Readonly<Record<string, string>>,
  locale: string,
  fallbackLocale = 'en',
): string {
  return (
    value[locale] ??
    value[locale.split('-')[0] ?? locale] ??
    value[fallbackLocale] ??
    value['*'] ??
    Object.values(value)[0] ??
    ''
  );
}
