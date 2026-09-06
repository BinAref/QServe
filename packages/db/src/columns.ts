/**
 * Column codecs.
 *
 * SQLite has no boolean, no JSON and no timestamp type. Rather than scatter
 * `row.visible === 1` and `JSON.parse(row.name)` through every repository, all
 * conversion happens here, so a column's storage shape is defined once.
 */

export const toDbBool = (value: boolean): 0 | 1 => (value ? 1 : 0);
export const fromDbBool = (value: unknown): boolean => value === 1 || value === true;

/** Timestamps are ISO-8601 UTC strings: sortable as text, readable in a dump. */
export const nowIso = (): string => new Date().toISOString();

export const toDbJson = (value: unknown): string => JSON.stringify(value ?? null);

export function fromDbJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed === null ? fallback : parsed;
  } catch {
    // A corrupt JSON column must not take down a whole service; the row still
    // has its scalar fields and the caller gets a sane default.
    return fallback;
  }
}

/** Comma-free string list storage, used for permission and locale arrays. */
export const toDbStringList = (values: readonly string[]): string => JSON.stringify(values);
export const fromDbStringList = (value: unknown): string[] => fromDbJson<string[]>(value, []);
