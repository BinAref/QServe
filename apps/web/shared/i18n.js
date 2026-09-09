/**
 * Runtime translation (spec §32).
 *
 * The server sends one fully resolved dictionary — the chosen locale merged
 * over its fallback chain — so this module never has to implement fallback and
 * a partially translated language still renders every screen.
 *
 * It also owns text direction: setting the locale sets `dir` on <html>, which
 * is all the RTL support a CSS file written with logical properties needs.
 */

import { api } from './api.js';

const STORAGE_KEY = 'qserve.locale';

let pack = { locale: 'en', direction: 'ltr', strings: {} };
let available = [];
const listeners = new Set();

/** `t('orders.order_number', { number: 42 })` */
export function t(key, params) {
  const template = pack.strings[key];
  if (template === undefined) {
    // Showing the key is the right failure: it is obvious in testing and still
    // readable to staff, unlike an empty label.
    return key;
  }
  if (!params) return template;
  return template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (whole, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole);
}

/** Translate an enum value: `te('orders.status', 'PREPARING')`. */
export const te = (prefix, value) =>
  value ? t(`${prefix}.${String(value).toLowerCase()}`) : '';

export const locale = () => pack.locale;
export const direction = () => pack.direction;
export const isRtl = () => pack.direction === 'rtl';
export const availableLocales = () => available;

/** "ar" → "العربية". Falls back to the code, which is better than nothing. */
export const languageName = (code) =>
  available.find((entry) => entry.locale === code)?.name ?? code;
export const currentPack = () => pack;

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The locale to start with: the viewer's choice, then the restaurant default. */
/**
 * Which language to open in, before anybody has chosen one.
 *
 * Three sources, in the order a person would expect:
 *
 *   1. what this device chose last, if it has been here before
 *   2. what this device's own language is — a diner scanning a table code has
 *      a phone set to the language they read, and it is the only thing we know
 *      about them. Only ever matched against the languages the restaurant has
 *      actually enabled: this picks among the restaurant's offer, it does not
 *      widen it.
 *   3. the restaurant's own default, and English behind that
 *
 * `navigator.languages` is ordered by preference, so a phone set to Turkish
 * then English gets Turkish in a restaurant offering both, and English in one
 * offering English and Arabic. Region is ignored — `tr-CY` is Turkish, and a
 * menu is not going to differ between Cyprus and Türkiye.
 */
export function preferredLocale(fallback = 'en') {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // Private browsing on a diner's phone: fall through to what follows.
  }

  /*
   * Only the languages this restaurant has switched on.
   *
   * `/api/i18n/locales` answers with every pack the installation has, each
   * carrying whether it is enabled — the console needs the full list to draw
   * the switches. A terminal does not: offering a diner a language the
   * restaurant turned off would hand them a half-translated menu.
   */
  const offered = available
    .filter((entry) => entry.enabled !== false)
    .map((entry) => entry.locale);
  const wanted = navigator.languages?.length
    ? navigator.languages
    : [navigator.language].filter(Boolean);

  for (const tag of wanted) {
    const base = String(tag).toLowerCase().split('-')[0];
    // An exact tag first, so a pack published as `pt-BR` still wins outright.
    const match = offered.find((code) => code.toLowerCase() === String(tag).toLowerCase())
      ?? offered.find((code) => code.toLowerCase().split('-')[0] === base);
    if (match) return match;
  }

  return fallback;
}

export async function loadLocales() {
  const result = await api.get('/api/i18n/locales');
  available = result.locales;
  return result;
}

export async function setLocale(code, { remember = true } = {}) {
  const loaded = await api.get(`/api/i18n/${encodeURIComponent(code)}`);
  pack = loaded;

  document.documentElement.lang = loaded.locale;
  document.documentElement.dir = loaded.direction;

  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // Not being able to remember a language choice is not worth an error.
    }
  }

  for (const listener of listeners) listener(pack);
  return pack;
}

/** Number, date and currency formatting, all locale-aware. */
export const formatNumber = (value, options) =>
  new Intl.NumberFormat(pack.formatLocale ?? pack.locale, options).format(value);

export function formatMoney(minor, currency) {
  if (!currency) return String(minor);
  const major = minor / 10 ** currency.decimals;
  const number = formatNumber(major, {
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals,
  });
  return currency.symbolPosition === 'before'
    ? `${currency.symbol} ${number}`
    : `${number} ${currency.symbol}`;
}

export const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString(pack.formatLocale ?? pack.locale, {
    hour: '2-digit', minute: '2-digit',
  });

export const formatDateTime = (iso) =>
  new Date(iso).toLocaleString(pack.formatLocale ?? pack.locale);

/** Pick the right string from a `{ en: …, ar: … }` value written by the owner. */
export function pick(localised, fallbackLocale = 'en') {
  if (!localised) return '';
  if (typeof localised === 'string') return localised;
  return (
    localised[pack.locale] ??
    localised[pack.locale.split('-')[0]] ??
    localised[fallbackLocale] ??
    localised['*'] ??
    Object.values(localised)[0] ??
    ''
  );
}

/** Render an ApiError as a sentence in the viewer's language. */
export function describeError(error) {
  if (!error) return t('error.internal');
  if (error.messageKey) {
    const message = t(error.messageKey);
    if (message !== error.messageKey) return message;
  }
  return error.message ?? t('error.internal');
}
