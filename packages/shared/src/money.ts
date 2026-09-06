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
