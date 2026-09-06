/**
 * Money is stored as an integer number of minor units (piastres, cents, kuruş)
 * in every table and every API payload. Floating point never touches a price.
 */

export interface CurrencyConfig {
  /** ISO-4217, e.g. "SAR", "TRY", "USD". */
  readonly code: string;
  /** Symbol shown in the UI; may differ per locale. */
  readonly symbol: string;
  /** Minor units per major unit exponent: 2 → 1.00, 0 → 1, 3 → 1.000. */
  readonly decimals: number;
  /** Where the symbol sits relative to the number in LTR layouts. */
  readonly symbolPosition: 'before' | 'after';
}

export const DEFAULT_CURRENCY: CurrencyConfig = {
  code: 'SAR',
  symbol: 'SAR',
  decimals: 2,
  symbolPosition: 'after',
};

/* ------------------------------------------------------ several currencies */

/**
 * A currency the restaurant accepts, as it defines it.
 *
 * A restaurant near a border, or one serving tourists, prices some things in
 * one currency and some in another. So a currency is a row the owner writes —
 * code, symbol, how many decimals, which side the symbol sits — not a constant
 * compiled into the product.
 *
 * `rateToBase` is what keeps the arithmetic honest. Exactly one currency is the
 * **base**: the one the till counts, the reports add up and the bill settles
 * in. Every other currency records how many base minor units one of its minor
 * units is worth, and **every order line stores the rate it used**, so a bill
 * printed last month never changes because the rate moved this morning.
 */
export interface Currency extends CurrencyConfig {
  /** Shown in the picker; the owner's own words, translatable. */
  readonly name: Readonly<Record<string, string>>;
  /** Base minor units per one minor unit of this currency. The base is 1. */
  readonly rateToBase: number;
  readonly isBase: boolean;
  readonly enabled: boolean;
  readonly sortOrder: number;
}

/** ISO-4217 shape: three letters. Restaurants type it, so be forgiving of case. */
export const CURRENCY_CODE_PATTERN = /^[A-Za-z]{3}$/;

/**
 * Convert an amount into the base currency, rounded once, at the end.
 *
 * Rounding here rather than per component matters: converting each modifier
 * separately and summing would drift by a unit or two on a large order, and a
 * bill that disagrees with itself is a bill a diner argues about.
 */
export function toBaseMinor(
  minor: number,
  rateToBase: number,
  baseDecimals: number,
  currencyDecimals: number,
): number {
  if (rateToBase === 1 && baseDecimals === currencyDecimals) return minor;
  // Move to major units, apply the rate, then back into the base's minor units.
  const major = minor / 10 ** currencyDecimals;
  return Math.round(major * rateToBase * 10 ** baseDecimals);
}

export const toMinorUnits = (major: number, decimals: number): number =>
  Math.round(major * 10 ** decimals);

export const toMajorUnits = (minor: number, decimals: number): number =>
  minor / 10 ** decimals;

/**
 * Percentage applied to a minor-unit amount, rounded half-up. Tax and service
 * charge both go through here so a receipt never disagrees with itself by a
 * rounding unit.
 */
export const applyRate = (minor: number, ratePercent: number): number =>
  Math.round((minor * ratePercent) / 100);

export function formatMoney(
  minor: number,
  currency: CurrencyConfig,
  locale: string,
): string {
  const major = toMajorUnits(minor, currency.decimals);
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals,
  }).format(major);
  return currency.symbolPosition === 'before'
    ? `${currency.symbol} ${number}`
    : `${number} ${currency.symbol}`;
}

/* -------------------------------------------------- typing an amount by hand */

export interface AmountProblem {
  /** A translation key, so the message reaches the typist in their language. */
  readonly messageKey: string;
  readonly params?: Record<string, unknown>;
}

export interface ParsedAmount {
  readonly ok: boolean;
  /** The value in minor units. Only meaningful when `ok`. */
  readonly minor: number;
  /** What is wrong, if anything. */
  readonly problem: AmountProblem | null;
}

/**
 * The one place that decides whether typed text is a price.
 *
 * Every rule here exists because of a way a real till gets a wrong number into
 * a real bill: a stray letter, a decimal point left dangling at the end of
 * "12.", a second point in "1.2.3", more decimals than the currency has. The
 * same function runs in the browser as the field is typed and on the server
 * before the value is stored, so the two can never disagree about what a price
 * is.
 */
export function parseAmount(raw: string, decimals: number): ParsedAmount {
  const text = raw.trim();
  const fail = (messageKey: string, params?: Record<string, unknown>): ParsedAmount => ({
    ok: false,
    minor: 0,
    problem: params ? { messageKey, params } : { messageKey },
  });

  if (text === '') return fail('amount.error.required');

  // Digits and at most one dot. Not a regex on the whole string, because the
  // reason it failed is what the typist needs to be told.
  for (const character of text) {
    if (character !== '.' && (character < '0' || character > '9')) {
      return fail('amount.error.digits_only', { character });
    }
  }

  const points = [...text].filter((character) => character === '.').length;
  if (points > 1) return fail('amount.error.one_point');
  if (text.endsWith('.')) return fail('amount.error.trailing_point');
  if (text.startsWith('.')) return fail('amount.error.leading_point');

  const [whole = '', fraction = ''] = text.split('.');
  if (decimals === 0 && points === 1) return fail('amount.error.no_decimals');
  if (fraction.length > decimals) {
    return fail('amount.error.too_many_decimals', { decimals });
  }
  // 18 digits is comfortably inside a safe integer once scaled, and no menu
  // needs more.
  if (whole.length > 15) return fail('amount.error.too_large');

  const padded = fraction.padEnd(decimals, '0');
  const minor = Number(`${whole || '0'}${padded}`);
  if (!Number.isSafeInteger(minor)) return fail('amount.error.too_large');

  return { ok: true, minor, problem: null };
}

/**
 * Strip what a typist cannot mean, as they type: anything but digits and one
 * decimal point, and never more decimals than the currency has. Used for the
 * live keystroke filter — it never reports an error, it just refuses to let
 * the character in, so the field cannot hold nonsense in the first place.
 */
export function sanitiseAmountInput(raw: string, decimals: number): string {
  let out = '';
  let seenPoint = false;

  for (const character of raw) {
    if (character >= '0' && character <= '9') {
      // A digit past the currency's precision is silently dropped rather than
      // accepted and rounded away later.
      if (seenPoint && decimals > 0) {
        const fraction = out.length - out.indexOf('.') - 1;
        if (fraction >= decimals) continue;
      }
      out += character;
      continue;
    }
    if (character === '.' && !seenPoint && decimals > 0 && out !== '') {
      seenPoint = true;
      out += character;
    }
  }
  return out;
}

/** Minor units back into the text the field shows. */
export const amountToInput = (minor: number, decimals: number): string =>
  decimals === 0
    ? String(Math.round(minor))
    : (minor / 10 ** decimals).toFixed(decimals);

/** Line total: unit price plus selected extras, times quantity. */
export function lineTotal(
  unitPriceMinor: number,
  modifiersMinor: readonly number[],
  quantity: number,
): number {
  const unit = modifiersMinor.reduce((sum, m) => sum + m, unitPriceMinor);
  return unit * quantity;
}

export interface OrderTotals {
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly serviceMinor: number;
  readonly totalMinor: number;
}

export interface TotalsInput {
  readonly lineTotalsMinor: readonly number[];
  readonly discountMinor?: number;
  /** Percent, e.g. 15 for 15%. */
  readonly taxRatePercent?: number;
  readonly serviceRatePercent?: number;
  /** When true the listed prices already contain tax (common in the Gulf/EU). */
  readonly taxInclusive?: boolean;
}

/**
 * Single source of truth for order arithmetic. The cashier UI, the receipt
 * printer and the reports module all call this, so they cannot drift apart.
 */
export function computeTotals(input: TotalsInput): OrderTotals {
  const subtotal = input.lineTotalsMinor.reduce((a, b) => a + b, 0);
  const discount = Math.min(input.discountMinor ?? 0, subtotal);
  const net = subtotal - discount;

  const service = applyRate(net, input.serviceRatePercent ?? 0);
  const taxable = net + service;
  const taxRate = input.taxRatePercent ?? 0;

  if (input.taxInclusive) {
    // Prices already include tax: extract it rather than adding on top.
    const tax = Math.round(taxable - taxable / (1 + taxRate / 100));
    return {
      subtotalMinor: subtotal,
      discountMinor: discount,
      taxMinor: tax,
      serviceMinor: service,
      totalMinor: taxable,
    };
  }

  const tax = applyRate(taxable, taxRate);
  return {
    subtotalMinor: subtotal,
    discountMinor: discount,
    taxMinor: tax,
    serviceMinor: service,
    totalMinor: taxable + tax,
  };
}
