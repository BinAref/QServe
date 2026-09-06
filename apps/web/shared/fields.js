/**
 * Input controls that carry their own rules.
 *
 * A price typed into a plain text box is how a wrong number gets into a real
 * bill: a stray letter, a decimal point left dangling at the end of "12.", a
 * second point in "1.2.3". This module is the answer — one control, used by the
 * menu builder, the cashier and anywhere else money is typed, that refuses the
 * keystroke it cannot mean and explains itself when the typist leaves.
 */

import { h, mount } from './dom.js';
import { t, formatMoney, pick } from './i18n.js';
import { amountToInput, parseAmount, sanitiseAmountInput, toBaseMinor } from './money.js';

/**
 * A price field: an amount, optionally a currency to price it in, a live
 * preview of what it will look like, and an error the moment it is wrong.
 *
 * Returns handles rather than markup alone, because the caller needs to ask
 * "is this valid?" before it submits, and to hear about changes as they happen.
 */
export function moneyField({
  name = 'priceMinor',
  label,
  value = 0,
  currencies = [],
  currencyCode = null,
  baseCurrency = null,
  required = true,
  disabled = false,
  onChange = null,
  hint = null,
} = {}) {
  const base = baseCurrency ?? currencies.find((entry) => entry.isBase) ?? null;
  let selected = pickCurrency(currencies, currencyCode, base);
  let touched = false;

  const input = h('input', {
    name,
    // A phone shows a numeric keypad for this, and no spinner arrows to nudge
    // a price by one unit unnoticed.
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    class: 'qs-amount-input',
    'aria-label': label ?? t('menu.price'),
    disabled,
    value: amountToInput(value, selected?.decimals ?? 2),
  });

  const preview = h('span', { class: 'qs-amount-preview' });
  const error = h('p', { class: 'qs-field-error', role: 'alert' });
  const field = h('div', { class: 'qs-amount' });

  const currencySelect = currencies.length > 1
    ? h('select', {
        name: `${name}Currency`,
        class: 'qs-amount-currency',
        'aria-label': t('currencies.title'),
        disabled,
      }, currencies.map((currency) =>
        h('option', {
          value: currency.code,
          selected: currency.code === selected?.code,
        }, `${currency.symbol} ${currency.code}`)))
    : null;

  /** The current state: what was typed, whether it is a price, and what it is worth. */
  const read = () => {
    const parsed = parseAmount(input.value, selected?.decimals ?? 2);
    return {
      raw: input.value,
      currency: selected,
      currencyCode: selected && !selected.isBase ? selected.code : null,
      ...parsed,
    };
  };

  const render = () => {
    const state = read();

    // The preview is the reassurance: it shows the number the way the diner
    // will see it, symbol and all, before anything is saved.
    if (state.ok) {
      preview.textContent = selected ? formatMoney(state.minor, selected) : '';
      preview.dataset.state = 'ok';

      // Priced in a foreign currency, show what the till will actually take —
      // otherwise nobody notices a rate typed one decimal place out.
      if (selected && base && !selected.isBase) {
        const inBase = toBaseMinor(state.minor, selected.rateToBase, base.decimals, selected.decimals);
        preview.textContent += ` · ${formatMoney(inBase, base)}`;
      }
    } else if (input.value === '' && !required) {
      preview.textContent = '';
      preview.dataset.state = 'empty';
    } else {
      preview.textContent = '';
      preview.dataset.state = 'error';
    }

    // Errors appear when the typist leaves the field, not while they are still
    // half-way through typing "12." on the way to "12.5".
    const showError = touched && !state.ok && (required || input.value !== '');
    error.textContent = showError ? t(state.problem.messageKey, state.problem.params) : '';
    field.dataset.invalid = String(showError);
    input.setAttribute('aria-invalid', String(showError));

    onChange?.(state);
    return state;
  };

  input.addEventListener('input', () => {
    // Filter first: what cannot be a price never reaches the field, so the
    // caret does not jump around correcting it afterwards.
    const cleaned = sanitiseAmountInput(input.value, selected?.decimals ?? 2);
    if (cleaned !== input.value) {
      const caret = input.selectionStart ?? cleaned.length;
      const removed = input.value.length - cleaned.length;
      input.value = cleaned;
      input.setSelectionRange(Math.max(0, caret - removed), Math.max(0, caret - removed));
    }
    render();
  });

  input.addEventListener('blur', () => {
    touched = true;
    const state = read();
    // Tidy a valid entry into the currency's own shape: "7" becomes "7.00", so
    // a column of prices lines up and nobody wonders whether it saved.
    if (state.ok) input.value = amountToInput(state.minor, selected?.decimals ?? 2);
    render();
  });

  currencySelect?.addEventListener('change', () => {
    const previous = selected;
    selected = currencies.find((entry) => entry.code === currencySelect.value) ?? base;

    // Changing the currency keeps the number the owner typed rather than
    // converting it: "20" in lira means twenty lira, not the lira equivalent
    // of twenty riyals. Only the precision is re-applied.
    const state = parseAmount(input.value, previous?.decimals ?? 2);
    if (state.ok) input.value = amountToInput(state.minor, selected?.decimals ?? 2);
    render();
  });

  mount(field,
    h('div', { class: 'qs-amount-row' },
      input,
      currencySelect),
    h('div', { class: 'qs-amount-foot' },
      preview,
      hint ? h('span', { class: 'qs-xs qs-muted' }, hint) : null),
    error);

  render();

  return {
    node: label
      ? h('label', { class: 'qs-field' }, h('span', {}, label), field)
      : field,
    field,
    input,
    /** `{ ok, minor, currencyCode, problem }` — everything a caller needs. */
    read,
    /** Mark as touched and show any error. Called before submitting. */
    validate() {
      touched = true;
      return render();
    },
    setValue(minor, code = undefined) {
      if (code !== undefined) {
        selected = pickCurrency(currencies, code, base);
        if (currencySelect && selected) currencySelect.value = selected.code;
      }
      input.value = amountToInput(minor, selected?.decimals ?? 2);
      touched = false;
      render();
    },
    focus: () => input.focus(),
  };
}

function pickCurrency(currencies, code, base) {
  if (!code) return base ?? currencies[0] ?? null;
  return currencies.find((entry) => entry.code === code) ?? base ?? currencies[0] ?? null;
}

/**
 * A whole-number field — quantities, seats, percentages.
 *
 * Same discipline as the price: digits only, refused at the keystroke, with the
 * bounds enforced when the typist leaves rather than silently clamped as they
 * type, which would fight anyone editing "10" into "100".
 */
export function integerField({
  name,
  label,
  value = 0,
  min = 0,
  max = 9999,
  disabled = false,
  onChange = null,
} = {}) {
  const input = h('input', {
    name,
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    class: 'qs-amount-input',
    disabled,
    value: String(value),
  });
  const error = h('p', { class: 'qs-field-error', role: 'alert' });
  const field = h('div', { class: 'qs-amount' });
  let touched = false;

  const read = () => {
    const raw = input.value.trim();
    if (raw === '') return { ok: false, value: min, problem: { messageKey: 'amount.error.required' } };
    const number = Number(raw);
    if (!Number.isInteger(number)) {
      return { ok: false, value: min, problem: { messageKey: 'amount.error.whole_number' } };
    }
    if (number < min || number > max) {
      return {
        ok: false,
        value: number,
        problem: { messageKey: 'amount.error.out_of_range', params: { min, max } },
      };
    }
    return { ok: true, value: number, problem: null };
  };

  const render = () => {
    const state = read();
    const show = touched && !state.ok;
    error.textContent = show ? t(state.problem.messageKey, state.problem.params) : '';
    field.dataset.invalid = String(show);
    input.setAttribute('aria-invalid', String(show));
    onChange?.(state);
    return state;
  };

  input.addEventListener('input', () => {
    const cleaned = [...input.value].filter((c) => c >= '0' && c <= '9').join('');
    if (cleaned !== input.value) {
      const caret = Math.max(0, (input.selectionStart ?? 0) - (input.value.length - cleaned.length));
      input.value = cleaned;
      input.setSelectionRange(caret, caret);
    }
    render();
  });
  input.addEventListener('blur', () => { touched = true; render(); });

  mount(field, input, error);
  render();

  return {
    node: label ? h('label', { class: 'qs-field' }, h('span', {}, label), field) : field,
    field,
    input,
    read,
    validate() { touched = true; return render(); },
    setValue(next) { input.value = String(next); touched = false; render(); },
    focus: () => input.focus(),
  };
}

/** A currency picker on its own, for screens that choose one without a price. */
export function currencySelect({ currencies, value = null, name = 'currencyCode', onChange = null }) {
  const select = h('select', { name, class: 'qs-amount-currency' },
    currencies.map((currency) =>
      h('option', { value: currency.code, selected: currency.code === value },
        `${currency.symbol} ${currency.code}${
          pick(currency.name) ? ` — ${pick(currency.name)}` : ''}`)));
  if (onChange) select.addEventListener('change', () => onChange(select.value));
  return select;
}
