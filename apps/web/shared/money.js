/**
 * Browser-side mirror of the amount rules in `@qserve/shared`.
 *
 * The rules live in two places for one reason: the field has to answer the
 * typist on the keystroke, and the server has to answer nobody at all — it
 * simply refuses. A test (`portability.test.ts`) runs the same table of inputs
 * through both copies and fails if they ever disagree, so "the browser let it
 * through but the server refused" cannot happen.
 */

/**
 * Digits and at most one decimal point, with the currency's precision.
 *
 * A point left dangling at the end is not an error: somebody typing "12.50"
 * passes through "12." on the way. It is accepted while typing and dropped
 * here, so the field never stores one and nobody is warned about a keystroke
 * they were in the middle of.
 */
export function parseAmount(raw, decimals) {
  const text = String(raw ?? '').trim().replace(/\.$/, '');
  const fail = (messageKey, params) => ({
    ok: false,
    minor: 0,
    problem: params ? { messageKey, params } : { messageKey },
  });

  if (text === '') return fail('amount.error.required');

  for (const character of text) {
    if (character !== '.' && (character < '0' || character > '9')) {
      return fail('amount.error.digits_only', { character });
    }
  }

  const points = [...text].filter((character) => character === '.').length;
  if (points > 1) return fail('amount.error.one_point');
  if (text.startsWith('.')) return fail('amount.error.leading_point');

  const [whole = '', fraction = ''] = text.split('.');
  if (decimals === 0 && points === 1) return fail('amount.error.no_decimals');
  if (fraction.length > decimals) return fail('amount.error.too_many_decimals', { decimals });
  if (whole.length > 15) return fail('amount.error.too_large');

  const minor = Number(`${whole || '0'}${fraction.padEnd(decimals, '0')}`);
  if (!Number.isSafeInteger(minor)) return fail('amount.error.too_large');

  return { ok: true, minor, problem: null };
}

/**
 * What a keystroke is allowed to leave in the field. Never reports an error —
 * it simply refuses the character, so the field cannot hold nonsense at all.
 */
export function sanitiseAmountInput(raw, decimals) {
  let out = '';
  let seenPoint = false;

  for (const character of String(raw ?? '')) {
    if (character >= '0' && character <= '9') {
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

export const amountToInput = (minor, decimals) =>
  decimals === 0
    ? String(Math.round(minor))
    : (minor / 10 ** decimals).toFixed(decimals);

/** Convert into the base currency the same way the server does. */
export function toBaseMinor(minor, rateToBase, baseDecimals, currencyDecimals) {
  if (rateToBase === 1 && baseDecimals === currencyDecimals) return minor;
  return Math.round((minor / 10 ** currencyDecimals) * rateToBase * 10 ** baseDecimals);
}

/** Which of a currency's two written forms a price uses. */
export const CurrencyDisplay = { CODE: 'CODE', SYMBOL: 'SYMBOL' };

/**
 * A currency as it should be *written* for this price.
 *
 * Formatting reads `symbol`, so choosing the code is a matter of handing the
 * formatter a currency whose symbol is the code. One substitution, and every
 * screen follows without knowing about the choice.
 */
export function displayed(currency, override) {
  if (!currency) return currency;
  const form = override ?? currency.display ?? CurrencyDisplay.SYMBOL;
  return form === CurrencyDisplay.CODE ? { ...currency, symbol: currency.code } : currency;
}
