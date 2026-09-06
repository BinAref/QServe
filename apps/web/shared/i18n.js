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
export const currentPack = () => pack;

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The locale to start with: the viewer's choice, then the restaurant default. */
export function preferredLocale(fallback = 'en') {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // Private browsing on a diner's phone: fall through to the default.
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
