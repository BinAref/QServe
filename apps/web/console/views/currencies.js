/**
 * Currencies (spec §35).
 *
 * A restaurant near a border, or one serving tourists, prices some dishes in
 * one currency and some in another. Adding the lira here is typing `TRY` and
 * `₺` — after which every price field on the menu offers it.
 *
 * One currency is the **base**: what the till counts, what the reports add up,
 * what a bill settles in. The screen says so out loud, because a rate typed one
 * decimal place out is a mistake that only shows up in the takings.
 */

import { api, guard, t, toast } from '../../shared/boot.js';
import { h, mount, modal, confirmDialog } from '../../shared/dom.js';
import { pick, formatMoney } from '../../shared/i18n.js';
import { moneyField, localisedField, mergeLocalised } from '../../shared/fields.js';
import { pageHeader, reroute } from '../app.js';

export async function renderCurrencies(container) {
  const { currencies, base } = await api.get('/api/currencies');

  /**
   * One currency, one line: what it is, what a diner reads, what it is worth,
   * and what it is already priced on. The card this replaced said "SAR" three
   * times and "0 dish(es), 0 add-on(s)" once.
   */
  const row = (currency) => {
    const usage = h('p', { class: 'qs-row-hint' });
    // Asked lazily: the answer only matters when someone reaches for delete.
    void api.get(`/api/currencies/${currency.code}/usage`)
      .then((counts) => {
        usage.textContent = counts.products + counts.addons === 0
          ? t('currencies.in_use_none')
          : t('currencies.in_use', counts);
      })
      .catch(() => {});

    // One unit of this currency, shown in the base — the number a mistyped
    // rate makes obviously wrong.
    const oneUnit = 10 ** currency.decimals;
    const inBase = Math.round(currency.rateToBase * 10 ** base.decimals);

    return h('div', { class: 'qs-row-item' },
      h('div', {},
        h('div', { class: 'qs-row-label' },
          currency.code,
          pick(currency.name) ? h('span', { class: 'qs-muted' }, ` — ${pick(currency.name)}`) : null,
          currency.isBase
            ? h('span', { class: 'qs-badge qs-badge-success' }, t('currencies.base'))
            : null),

        // What a diner will actually read, before any dish is priced — and for
        // anything but the base, the same example carries the rate, so there is
        // no reason to print "1.00 ₺" twice on one line.
        h('p', { class: 'qs-row-hint' },
          currency.isBase
            ? t('currencies.shown_as', { example: formatMoney(oneUnit, currency) })
            : `${formatMoney(oneUnit, currency)} = ${formatMoney(inBase, base)}`,
          currency.enabled ? '' : ` · ${t('common.disabled')}`),

        currency.isBase
          ? h('p', { class: 'qs-row-hint' }, t('currencies.base_explain'))
          : usage),

      h('div', { class: 'qs-row-control' },
        h('button', {
          class: 'qs-btn qs-btn-sm',
          onClick: () => openCurrencyForm(container, currency, base, currencies),
        }, t('common.edit')),

        currency.isBase
          ? null
          : h('button', {
              class: 'qs-btn qs-btn-sm qs-btn-ghost',
              onClick: async () => {
                const ok = await confirmDialog({
                  title: t('currencies.make_base'),
                  message: t('currencies.make_base_confirm'),
                  confirmLabel: t('currencies.make_base'),
                  cancelLabel: t('common.cancel'),
                  danger: false,
                });
                if (!ok) return;
                const done = await guard(() => api.post(`/api/currencies/${currency.code}/base`));
                if (!done) return;
                toast(t('common.saved'), 'success');
                await reroute();
              },
            }, t('currencies.make_base')),

        // The base currency has no delete, and the reason is under the row
        // rather than in the place a button would be.
        currency.isBase
          ? null
          : h('button', {
              class: 'qs-btn qs-btn-sm qs-btn-ghost',
              onClick: async () => {
                const counts = await guard(() => api.get(`/api/currencies/${currency.code}/usage`));
                if (!counts) return;
                if (counts.products + counts.addons > 0) {
                  toast(t('currencies.delete_in_use'), 'error');
                  return;
                }
                const ok = await confirmDialog({
                  title: t('common.delete'),
                  message: `${currency.code} — ${currency.symbol}`,
                  confirmLabel: t('common.delete'),
                  cancelLabel: t('common.cancel'),
                });
                if (!ok) return;
                const done = await guard(() => api.del(`/api/currencies/${currency.code}`));
                if (done === undefined) return;
                await reroute();
              },
            }, t('common.delete'))));
  };

  mount(container,
    pageHeader(t('currencies.title'),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        onClick: () => openCurrencyForm(container, null, base, currencies),
      }, t('currencies.add'))),

    h('p', { class: 'qs-muted' }, t('currencies.subtitle')),
    h('div', { class: 'qs-card qs-narrow' },
      h('div', { class: 'qs-rows' }, currencies.map(row))));
}

function openCurrencyForm(container, currency, base, existing) {
  const isNew = currency === null;

  const codeInput = h('input', {
    name: 'code', required: true, maxlength: '3', minlength: '3',
    pattern: '[A-Za-z]{3}', placeholder: 'TRY',
    value: currency?.code ?? '', readonly: !isNew,
    style: { textTransform: 'uppercase' },
  });
  const symbolInput = h('input', {
    name: 'symbol', required: true, maxlength: '8', placeholder: '₺',
    value: currency?.symbol ?? '',
  });
  // The currency's name is read by whoever is reading the console, so it is
  // written the same way every other name is: one box, in this language.
  const nameField = localisedField(t('currencies.name'), 'name', currency?.name ?? {}, {
    placeholder: 'Turkish lira',
  });
  const nameInput = nameField.querySelector('input');
  const decimalsSelect = h('select', { name: 'decimals' },
    [0, 2, 3].map((value) =>
      h('option', { value: String(value), selected: (currency?.decimals ?? 2) === value },
        String(value))));
  const positionSelect = h('select', { name: 'symbolPosition' },
    h('option', { value: 'before', selected: currency?.symbolPosition === 'before' },
      t('currencies.position_before')),
    h('option', { value: 'after', selected: (currency?.symbolPosition ?? 'after') === 'after' },
      t('currencies.position_after')));

  // Which form prices in this currency take unless a dish says otherwise. Most
  // restaurants set it once here and never think about it again.
  const displaySelect = h('select', { name: 'display' },
    h('option', { value: 'SYMBOL', selected: (currency?.display ?? 'SYMBOL') === 'SYMBOL' },
      t('currencies.as_symbol')),
    h('option', { value: 'CODE', selected: currency?.display === 'CODE' },
      t('currencies.as_code')));

  /**
   * The rate is money too, so it is typed through the same control — digits and
   * one decimal point, nothing else — and previewed in the base currency, where
   * a misplaced decimal point is impossible to miss.
   */
  const rate = moneyField({
    name: 'rateToBase',
    value: Math.round((currency?.rateToBase ?? 1) * 10 ** 6),
    currencies: [{ ...base, decimals: 6, isBase: true }],
    baseCurrency: { ...base, decimals: 6 },
    hint: t('currencies.rate_help'),
  });

  const isBase = currency?.isBase === true;
  const preview = h('p', { class: 'qs-small' });

  const drawPreview = () => {
    const state = rate.read();
    const symbol = symbolInput.value || '¤';
    const decimals = Number(decimalsSelect.value);
    const shape = { symbol, decimals, symbolPosition: positionSelect.value };
    const one = 10 ** decimals;

    preview.textContent = state.ok
      ? `${formatMoney(one, shape)} = ${formatMoney(
          Math.round((state.minor / 10 ** 6) * 10 ** base.decimals), base)}`
      : '';
  };
  for (const node of [symbolInput, decimalsSelect, positionSelect, rate.input]) {
    node.addEventListener('input', drawPreview);
    node.addEventListener('change', drawPreview);
  }
  drawPreview();

  const dialog = modal({
    title: isNew ? t('currencies.add') : `${t('common.edit')} — ${currency.code}`,
    body: h('div', {},
      h('div', { class: 'qs-grid qs-grid-2' },
        h('label', { class: 'qs-field' },
          h('span', {}, t('currencies.code')), codeInput,
          h('small', { class: 'qs-muted' }, t('currencies.code_help'))),
        h('label', { class: 'qs-field' },
          h('span', {}, t('currencies.symbol')), symbolInput,
          h('small', { class: 'qs-muted' }, t('currencies.symbol_help'))),
        nameField,
        h('label', { class: 'qs-field' },
          h('span', {}, t('currencies.decimals')), decimalsSelect),
        h('label', { class: 'qs-field' },
          h('span', {}, t('currencies.position')), positionSelect),
        h('label', { class: 'qs-field' },
          h('span', {}, t('currencies.display')), displaySelect)),

      isBase
        ? h('p', { class: 'qs-muted qs-small' }, t('currencies.base_explain'))
        : h('div', {},
            h('div', { class: 'qs-section-title' },
              t('currencies.rate', { base: base.code })),
            rate.node,
            preview)),

    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'save',
        onClick: async (event) => {
          event.preventDefault();

          const state = isBase ? { ok: true, minor: 10 ** 6 } : rate.validate();
          if (!state.ok) return;

          const payload = {
            symbol: symbolInput.value.trim(),
            name: mergeLocalised(currency?.name ?? {}, { name: nameInput.value }, 'name'),
            decimals: Number(decimalsSelect.value),
            symbolPosition: positionSelect.value,
            display: displaySelect.value,
            ...(isBase ? {} : { rateToBase: state.minor / 10 ** 6 }),
          };

          const saved = await guard(() => (isNew
            ? api.post('/api/currencies', { ...payload, code: codeInput.value.trim().toUpperCase() })
            : api.patch(`/api/currencies/${currency.code}`, payload)));
          if (!saved) return;

          toast(t('common.saved'), 'success');
          dialog.close('save');
          await reroute();
        },
      }, t('common.save')),
    ],
  });
}
