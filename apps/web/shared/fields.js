/**
 * Input controls that carry their own rules.
 *
 * A price typed into a plain text box is how a wrong number gets into a real
 * bill: a stray letter, a decimal point left dangling at the end of "12.", a
 * second point in "1.2.3". This module is the answer — one control, used by the
 * menu builder, the cashier and anywhere else money is typed, that refuses the
 * keystroke it cannot mean and explains itself when the typist leaves.
 */

import { h, mount, modal } from './dom.js';
import { t, formatMoney, pick } from './i18n.js';
import {
  amountToInput, CurrencyDisplay, displayed, parseAmount, sanitiseAmountInput, toBaseMinor,
} from './money.js';

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
  currencyDisplay = null,
  baseCurrency = null,
  required = true,
  disabled = false,
  onChange = null,
  hint = null,
} = {}) {
  const base = baseCurrency ?? currencies.find((entry) => entry.isBase) ?? null;
  let selected = pickCurrency(currencies, currencyCode, base);
  // Which of the currency's two written forms this price uses. Chosen here
  // rather than settings-wide, because a menu often mixes them deliberately:
  // the headline price in symbols, the wine list in codes.
  let display = currencyDisplay ?? selected?.display ?? CurrencyDisplay.SYMBOL;
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

  /**
   * The currency and the form, in one control.
   *
   * A dropdown of "SAR / ﷼ / TRY / ₺" would ask the owner to hold four options
   * in their head for two currencies. A grid of two columns — the code on one
   * side, the symbol on the other — is the same choice laid out the way it is
   * actually made: pick the money, then pick how it reads.
   */
  const currencyButton = h('button', {
    type: 'button',
    class: 'qs-amount-currency',
    disabled,
    'aria-haspopup': 'true',
  });

  const paintButton = () => {
    const shown = displayed(selected, display);
    currencyButton.textContent = shown ? shown.symbol : '';
    currencyButton.title = selected
      ? `${selected.code} · ${selected.symbol}`
      : '';
  };

  const openPicker = () => {
    const dialog = currencyGrid({
      currencies,
      selectedCode: selected?.code ?? null,
      selectedDisplay: display,
      onPick: (currency, form) => {
        const previous = selected;
        selected = currency;
        display = form;

        // The number the owner typed is kept: "20" in lira means twenty lira,
        // not the lira equivalent of twenty riyals. Only precision re-applies.
        const state = parseAmount(input.value, previous?.decimals ?? 2);
        if (state.ok) input.value = amountToInput(state.minor, selected?.decimals ?? 2);
        paintButton();
        render();
        dialog.close('pick');
      },
    });
  };
  currencyButton.addEventListener('click', openPicker);

  /** The current state: what was typed, whether it is a price, and what it is worth. */
  const read = () => {
    const parsed = parseAmount(input.value, selected?.decimals ?? 2);
    return {
      raw: input.value,
      currency: selected,
      currencyCode: selected && !selected.isBase ? selected.code : null,
      // Sent only when it differs from the currency's own preference, so most
      // dishes carry nothing and follow the currency if it is ever changed.
      currencyDisplay: display === selected?.display ? null : display,
      ...parsed,
    };
  };

  const render = () => {
    const state = read();

    // The preview is the reassurance: it shows the number the way the diner
    // will see it, symbol and all, before anything is saved.
    if (state.ok) {
      // Previewed exactly as the diner will read it — the chosen form included,
      // because "45.00 SAR" and "45.00 ﷼" are different menus.
      preview.textContent = selected ? formatMoney(state.minor, displayed(selected, display)) : '';
      preview.dataset.state = 'ok';

      // Priced in a foreign currency, show what the till will actually take —
      // otherwise nobody notices a rate typed one decimal place out.
      if (selected && base && !selected.isBase) {
        const inBase = toBaseMinor(state.minor, selected.rateToBase, base.decimals, selected.decimals);
        preview.textContent += ` · ${formatMoney(inBase, displayed(base))}`;
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

  paintButton();

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
    // Tidy a valid entry into the currency's own shape: "7" becomes "7.00" and
    // a point left dangling at the end simply goes, because "12." is twelve and
    // there is nothing to warn anybody about.
    if (state.ok) input.value = amountToInput(state.minor, selected?.decimals ?? 2);
    render();
  });

  mount(field,
    h('div', { class: 'qs-amount-row' },
      input,
      // With one currency written one way there is nothing to choose.
      currencies.length > 1 || (selected && selected.code !== selected.symbol)
        ? currencyButton
        : null),
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
    setValue(minor, code = undefined, form = undefined) {
      if (code !== undefined) selected = pickCurrency(currencies, code, base);
      if (form !== undefined) display = form ?? selected?.display ?? CurrencyDisplay.SYMBOL;
      input.value = amountToInput(minor, selected?.decimals ?? 2);
      touched = false;
      paintButton();
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

  paintButton();

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

/**
 * The currency picker: a grid, two across, one card per currency.
 *
 * Each card offers the same money two ways — `SAR` and `﷼` — because that is
 * how the choice is actually made: pick the money, then pick how it reads on
 * the menu. A flat dropdown of four entries for two currencies asks somebody
 * to hold the cross-product in their head instead.
 */
export function currencyGrid({ currencies, selectedCode, selectedDisplay, onPick }) {
  const half = (currency, form, text) => h('button', {
    type: 'button',
    class: 'qs-currency-form',
    'aria-pressed': String(currency.code === selectedCode && form === selectedDisplay),
    onClick: () => onPick(currency, form),
  },
    h('span', { class: 'qs-currency-glyph' }, text),
    h('span', { class: 'qs-currency-form-label' },
      t(form === CurrencyDisplay.CODE ? 'currencies.as_code' : 'currencies.as_symbol')));

  const card = (currency) => h('div', {
    class: 'qs-currency-card',
    'data-selected': String(currency.code === selectedCode),
  },
    h('div', { class: 'qs-currency-head' },
      h('strong', {}, currency.code),
      pick(currency.name) ? h('span', { class: 'qs-xs qs-muted' }, pick(currency.name)) : null,
      currency.isBase ? h('span', { class: 'qs-badge' }, t('currencies.base')) : null),
    h('div', { class: 'qs-currency-forms' },
      half(currency, CurrencyDisplay.SYMBOL, currency.symbol),
      // Offered only when the two forms actually differ; "SAR / SAR" is not a
      // choice, it is a decoration.
      currency.symbol === currency.code
        ? null
        : half(currency, CurrencyDisplay.CODE, currency.code)));

  return modal({
    title: t('currencies.title'),
    body: h('div', {},
      h('p', { class: 'qs-muted qs-small' }, t('currencies.pick_form')),
      h('div', { class: 'qs-currency-grid' }, currencies.map(card))),
    actions: [h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel'))],
  });
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

/* ------------------------------------------------------ localised inputs */

/**
 * One input per language the restaurant offers.
 *
 * Every name an owner types — a category, a dish, a station, what they call
 * their waiters — is stored per language rather than as one string, because the
 * diner reads the menu in Arabic while the kitchen ticket prints in English.
 * Three screens needed this control, so it lives here rather than three times.
 *
 * `locales` is passed in rather than read from a global: the console knows
 * which languages are enabled, this module has no business knowing.
 */
export function localisedField(label, name, current = {}, {
  locales = ['en'], textarea = false, placeholder = '', hint = '',
} = {}) {
  return h('div', { class: 'qs-field' },
    h('span', {}, label),
    hint ? h('span', { class: 'qs-xs qs-muted' }, hint) : null,
    locales.map((locale) =>
      h('div', { class: 'qs-row', style: { marginBlockEnd: '6px' } },
        h('span', { class: 'qs-badge', style: { minWidth: '46px' } }, locale),
        textarea
          ? h('textarea', { name: `${name}.${locale}`, rows: '2' }, current[locale] ?? '')
          : h('input', {
              name: `${name}.${locale}`,
              value: current[locale] ?? '',
              ...(placeholder ? { placeholder } : {}),
            }))));
}

/** Collect `name.en`, `name.ar`, … back into one object, dropping blanks. */
export function collectLocalised(data, name, locales = ['en']) {
  const out = {};
  for (const locale of locales) {
    const value = String(data[`${name}.${locale}`] ?? '').trim();
    if (value) out[locale] = value;
  }
  return out;
}
