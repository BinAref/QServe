/**
 * Menu builder (spec §34).
 *
 * Available from the first minute of SETUP mode and never gated, because the
 * whole promise of the product is that a restaurant builds its *real* menu
 * before paying and keeps it afterwards.
 *
 * Reordering is drag-and-drop and persists the entire ordered list rather than
 * a moved index, so two people editing at once cannot leave the menu in an
 * order neither of them chose.
 */

import { api, guard, t, toast } from '../../shared/boot.js';
import { h, mount, modal, confirmDialog } from '../../shared/dom.js';
import { formatMoney, pick } from '../../shared/i18n.js';
import {
  moneyField, integerField, localisedField, mergeLocalised, languageNote,
} from '../../shared/fields.js';
import { displayed } from '../../shared/money.js';
import { Permission } from '../../shared/events.js';
import { state, has, pageHeader, reroute } from '../app.js';

let categories = [];
let products = [];
let addons = [];
let currencies = [];
let selectedCategoryId = null;

const currency = () => state.status?.currency ?? { code: 'SAR', symbol: 'SAR', decimals: 2, symbolPosition: 'after' };

/** The currency a price is in: the product's own, or the base when it has none. */
const currencyOf = (code) =>
  currencies.find((entry) => entry.code === code)
  ?? currencies.find((entry) => entry.isBase)
  ?? currency();
const canManage = () => has(Permission.MENU_MANAGE);

/** The languages this restaurant offers; every name/description is per-language. */
const locales = () => state.status?.locales?.filter((entry) => entry.enabled).map((entry) => entry.locale) ?? ['en'];

async function load() {
  const [categoryResult, productResult, addonResult, restaurant, currencyResult] = await Promise.all([
    api.get('/api/menu/categories'),
    api.get('/api/menu/products'),
    api.get('/api/menu/addons'),
    api.get('/api/restaurant').catch(() => null),
    api.get('/api/currencies').catch(() => ({ currencies: [] })),
  ]);
  categories = categoryResult.categories;
  products = productResult.products;
  addons = addonResult.addons;
  currencies = currencyResult.currencies.filter((entry) => entry.enabled);
  if (restaurant) state.status.currency = restaurant.currency;

  if (!categories.some((entry) => entry.id === selectedCategoryId)) {
    selectedCategoryId = categories[0]?.id ?? null;
  }
}

/* ------------------------------------------------------------- drag sort */

/**
 * Minimal HTML5 drag reordering. `onDrop` receives the full id list, which is
 * exactly what the reorder endpoint wants.
 */
function makeSortable(container, itemSelector, onDrop) {
  let dragged = null;

  container.addEventListener('dragstart', (event) => {
    dragged = event.target.closest(itemSelector);
    if (!dragged) return;
    dragged.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragend', () => {
    dragged?.classList.remove('dragging');
    dragged = null;
    onDrop([...container.querySelectorAll(itemSelector)].map((node) => node.dataset.id));
  });

  container.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!dragged) return;
    const target = event.target.closest(itemSelector);
    if (!target || target === dragged) return;

    const box = target.getBoundingClientRect();
    const after = (event.clientY - box.top) / box.height > 0.5;
    target.parentNode.insertBefore(dragged, after ? target.nextSibling : target);
  });
}

/* ------------------------------------------------------------ categories */

function categoryPanel() {
  const list = h('div', {});

  mount(list, categories.map((category) =>
    h('button', {
      class: 'cat-item',
      draggable: canManage() ? 'true' : 'false',
      dataset: { id: category.id },
      'aria-current': String(category.id === selectedCategoryId),
      'data-hidden': String(!category.visible),
      onClick: () => {
        selectedCategoryId = category.id;
        void render(currentContainer);
      },
      onDblclick: () => canManage() && openCategoryForm(category),
    },
      canManage() ? h('span', { class: 'drag-handle' }, '⠿') : null,
      h('span', {}, pick(category.name) || '—'),
      h('span', { class: 'cat-count' },
        String(products.filter((product) => product.categoryId === category.id).length)))));

  if (canManage()) {
    makeSortable(list, '.cat-item', (ids) => {
      void api.post('/api/menu/reorder', { target: 'categories', ids }).catch(() => {});
    });
  }

  return h('aside', { class: 'qs-card' },
    h('div', { class: 'qs-card-head' },
      h('h3', { style: { margin: 0 } }, t('menu.categories')),
      canManage()
        ? h('button', { class: 'qs-btn qs-btn-ghost', onClick: () => openCategoryForm(null) }, '+')
        : null),
    categories.length === 0
      ? h('p', { class: 'qs-muted qs-small' }, t('menu.empty_categories'))
      : list,
    canManage()
      ? h('p', { class: 'qs-xs qs-muted', style: { marginBlockStart: 'var(--qs-spacing-sm)' } },
          t('menu.reorder_hint'))
      : null);
}

function openCategoryForm(category) {
  const form = h('form', { id: 'cat-form' },
    localisedField(t('common.name'), 'name', category?.name ?? {}),
    localisedField(t('common.description'), 'description', category?.description ?? {}, { textarea: true }),
    h('label', { class: 'qs-check' },
      h('input', { type: 'checkbox', name: 'visible', checked: category ? category.visible : true }),
      h('span', {}, t('common.visible'))));

  const dialog = modal({
    title: category ? t('common.edit') : t('menu.add_category'),
    body: form,
    actions: [
      category
        ? h('button', {
            class: 'qs-btn qs-btn-danger',
            value: 'delete',
            onClick: async (event) => {
              event.preventDefault();
              const count = products.filter((p) => p.categoryId === category.id).length;
              const ok = await confirmDialog({
                title: t('common.delete'),
                message: count > 0
                  ? `${pick(category.name)} — ${count} ${t('menu.products')}`
                  : pick(category.name),
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
              });
              if (!ok) return;
              await guard(() => api.del(`/api/menu/categories/${category.id}`));
              dialog.close();
              await render(currentContainer);
            },
          }, t('common.delete'))
        : null,
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());
          const payload = {
            name: mergeLocalised(category?.name ?? {}, data, 'name'),
            description: mergeLocalised(category?.description ?? {}, data, 'description'),
            visible: data.visible === 'on',
          };
          if (Object.keys(payload.name).length === 0) {
            toast(t('error.validation'), 'error');
            return;
          }
          const saved = await guard(() => category
            ? api.patch(`/api/menu/categories/${category.id}`, payload)
            : api.post('/api/menu/categories', payload));
          if (!saved) return;
          dialog.close();
          await render(currentContainer);
        },
      }, t('common.save')),
    ],
  });
}

/* -------------------------------------------------------------- products */

function productPanel() {
  const category = categories.find((entry) => entry.id === selectedCategoryId);
  if (!category) {
    return h('section', { class: 'qs-card' },
      h('div', { class: 'qs-empty' }, t('menu.empty_categories')));
  }

  const rows = products.filter((product) => product.categoryId === category.id);
  // The dishes rise into place in order rather than appearing all at once,
  // which is what makes a re-ordered list read as movement rather than a jump.
  const list = h('div', { class: 'qs-stagger' });

  mount(list, rows.map((product) =>
    h('div', {
      class: 'product-row',
      draggable: canManage() ? 'true' : 'false',
      dataset: { id: product.id },
    },
      canManage() ? h('span', { class: 'drag-handle' }, '⠿') : null,
      product.imageAssetId
        ? h('img', { class: 'product-thumb', src: `/assets/${product.imageAssetId}`, alt: '' })
        // A dish with no photograph gets a plate rather than an empty grey
        // rectangle, which reads as a picture that failed to load.
        : h('div', { class: 'product-thumb product-thumb-empty' }, '🍽'),
      h('div', { class: 'qs-grow' },
        h('div', {}, pick(product.name)),
        h('div', { class: 'qs-xs qs-muted' },
          product.station ? `${t('menu.station')}: ${product.station}` : '',
          product.options.length > 0 ? ` · ${product.options.length} ${t('menu.options')}` : '',
          product.addons.length > 0 ? ` · ${product.addons.length} ${t('menu.addons')}` : '')),
      !product.visible ? h('span', { class: 'qs-badge' }, t('common.hidden')) : null,
      !product.available ? h('span', { class: 'qs-badge qs-badge-error' }, t('menu.sold_out')) : null,
      h('span', { class: 'qs-strong' },
        formatMoney(product.priceMinor,
          displayed(currencyOf(product.currencyCode), product.currencyDisplay))),
      canManage()
        ? h('button', { class: 'qs-btn qs-btn-ghost', onClick: () => openProductForm(product) },
            t('common.edit'))
        : null)));

  if (canManage()) {
    makeSortable(list, '.product-row', (ids) => {
      void api.post('/api/menu/reorder', { target: 'products', ids }).catch(() => {});
    });
  }

  return h('section', { class: 'qs-card' },
    h('div', { class: 'qs-card-head' },
      h('h2', { style: { margin: 0 } }, pick(category.name)),
      canManage()
        ? h('button', { class: 'qs-btn qs-btn-primary', onClick: () => openProductForm(null) },
            t('menu.add_product'))
        : null),
    rows.length === 0 ? h('div', { class: 'qs-empty' }, t('menu.empty_products')) : list);
}

function openProductForm(product) {
  // Digits and one decimal point, refused at the keystroke, previewed as the
  // diner will see it — and the currency picked right beside the number.
  const price = moneyField({
    label: t('common.price'),
    value: product?.priceMinor ?? 0,
    currencies,
    currencyCode: product?.currencyCode ?? null,
    currencyDisplay: product?.currencyDisplay ?? null,
    hint: currencies.length > 1 ? t('menu.currency') : null,
  });
  const prep = integerField({
    name: 'prep',
    label: t('menu.prep_minutes'),
    value: product?.preparationMinutes ?? 0,
    min: 0,
    max: 600,
  });

  const form = h('form', { id: 'prod-form' },
    languageNote(locales()),
    localisedField(t('common.name'), 'name', product?.name ?? {}, { required: true }),
    localisedField(t('common.description'), 'description', product?.description ?? {}, { textarea: true }),

    h('div', { class: 'qs-grid qs-grid-2' },
      price.node,
      h('label', { class: 'qs-field' },
        h('span', {}, t('menu.station')),
        h('input', { name: 'station', value: product?.station ?? '', list: 'stations', maxlength: '40' })),
      prep.node,
      h('label', { class: 'qs-field' },
        h('span', {}, t('common.type')),
        h('select', { name: 'categoryId' }, categories.map((category) =>
          h('option', {
            value: category.id,
            selected: category.id === (product?.categoryId ?? selectedCategoryId),
          }, pick(category.name)))))),

    h('div', { class: 'qs-row' },
      h('label', { class: 'qs-check' },
        h('input', { type: 'checkbox', name: 'visible', checked: product ? product.visible : true }),
        h('span', {}, t('common.visible'))),
      h('label', { class: 'qs-check' },
        h('input', { type: 'checkbox', name: 'available', checked: product ? product.available : true }),
        h('span', {}, t('common.unavailable') + ' ✕'))),

    h('div', { class: 'qs-section-title' }, t('menu.image')),
    imageField(product),

    addons.length > 0
      ? h('div', {},
          h('div', { class: 'qs-section-title' }, t('menu.addons')),
          addons.map((addon) =>
            h('label', { class: 'qs-check' },
              h('input', {
                type: 'checkbox', name: `addon.${addon.id}`,
                checked: product?.addons.some((entry) => entry.id === addon.id) ?? false,
              }),
              h('span', {}, `${pick(addon.name)} · ${formatMoney(addon.priceMinor, currency())}`))))
      : null,

    product ? optionEditor(product) : h('p', { class: 'qs-xs qs-muted' }, t('menu.add_option')));

  const dialog = modal({
    title: product ? pick(product.name) : t('menu.add_product'),
    body: form,
    actions: [
      product
        ? h('button', {
            class: 'qs-btn qs-btn-danger',
            value: 'delete',
            onClick: async (event) => {
              event.preventDefault();
              const ok = await confirmDialog({
                title: t('common.delete'),
                message: pick(product.name),
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
              });
              if (!ok) return;
              await guard(() => api.del(`/api/menu/products/${product.id}`));
              dialog.close();
              await render(currentContainer);
            },
          }, t('common.delete'))
        : null,
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());

          // Ask the fields before asking the server: a price the typist can see
          // is wrong should never make a round trip to be told so.
          const amount = price.validate();
          if (!amount.ok) {
            price.focus();
            return;
          }
          const minutes = prep.validate();
          if (!minutes.ok) {
            prep.focus();
            return;
          }

          const payload = {
            categoryId: data.categoryId,
            name: mergeLocalised(product?.name ?? {}, data, 'name'),
            description: mergeLocalised(product?.description ?? {}, data, 'description'),
            priceMinor: amount.minor,
            currencyCode: amount.currencyCode,
            currencyDisplay: amount.currencyDisplay,
            station: String(data.station ?? '').trim() || null,
            preparationMinutes: minutes.value || null,
            visible: data.visible === 'on',
            available: data.available === 'on',
            addonIds: addons.filter((addon) => data[`addon.${addon.id}`] === 'on').map((addon) => addon.id),
          };
          if (Object.keys(payload.name).length === 0) {
            toast(t('error.validation'), 'error');
            return;
          }
          if (uploadedAssetId !== undefined) payload.imageAssetId = uploadedAssetId;

          const saved = await guard(() => product
            ? api.patch(`/api/menu/products/${product.id}`, payload)
            : api.post('/api/menu/products', payload));
          if (!saved) return;

          uploadedAssetId = undefined;
          dialog.close();
          await render(currentContainer);
        },
      }, t('common.save')),
    ],
  });

  form.append(h('datalist', { id: 'stations' },
    [...new Set(products.map((entry) => entry.station).filter(Boolean))]
      .map((station) => h('option', { value: station }))));
}

/* ------------------------------------------------------------- images */

let uploadedAssetId;

function imageField(product) {
  const preview = h('img', {
    class: 'product-thumb',
    style: { width: '96px', height: '96px' },
    src: product?.imageAssetId ? `/assets/${product.imageAssetId}` : '',
    alt: '',
  });

  return h('div', { class: 'qs-row' },
    preview,
    h('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml',
      onChange: async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const bytes = await file.arrayBuffer();
        const asset = await guard(() =>
          api.upload(`/api/assets?kind=product`, bytes, file.type));
        if (!asset) return;
        uploadedAssetId = asset.id;
        preview.src = `/assets/${asset.id}`;
        toast(t('common.saved'), 'success');
      },
    }),
    product?.imageAssetId
      ? h('button', {
          class: 'qs-btn qs-btn-ghost',
          type: 'button',
          onClick: () => {
            uploadedAssetId = null;
            preview.src = '';
          },
        }, t('common.delete'))
      : null);
}

/* ------------------------------------------------------------- options */

/**
 * Options and their choices ("Size: small / large", "Doneness: medium / well").
 * Edited inline on the product, because that is how an owner thinks about them.
 */
function optionEditor(product) {
  const container = h('div', {});

  const draw = () => {
    mount(container,
      h('div', { class: 'qs-section-title' }, t('menu.options')),
      product.options.map((option) =>
        h('div', { class: 'qs-card qs-card-tight', style: { marginBlockEnd: 'var(--qs-spacing-sm)' } },
          h('div', { class: 'qs-row qs-row-between' },
            h('strong', {}, pick(option.name)),
            h('span', { class: 'qs-row' },
              option.required ? h('span', { class: 'qs-badge' }, t('common.required')) : null,
              h('span', { class: 'qs-badge' }, `max ${option.maxSelect}`),
              h('button', {
                class: 'qs-btn qs-btn-ghost', type: 'button',
                onClick: async () => {
                  await guard(() => api.del(`/api/menu/options/${option.id}`));
                  product.options = product.options.filter((entry) => entry.id !== option.id);
                  draw();
                },
              }, '×'))),
          h('div', { class: 'qs-small' }, option.choices.map((choice) =>
            h('div', { class: 'qs-row qs-row-between', style: { paddingBlock: '3px' } },
              h('span', {}, pick(choice.name), choice.isDefault ? ' ★' : ''),
              h('span', { class: 'qs-row' },
                h('span', { class: 'qs-muted' },
                  choice.priceDeltaMinor
                    ? `+${formatMoney(choice.priceDeltaMinor,
                        displayed(currencyOf(product.currencyCode), product.currencyDisplay))}`
                    : '—'),
                h('button', {
                  class: 'qs-btn qs-btn-ghost', type: 'button',
                  onClick: async () => {
                    await guard(() => api.del(`/api/menu/choices/${choice.id}`));
                    option.choices = option.choices.filter((entry) => entry.id !== choice.id);
                    draw();
                  },
                }, '×'))))),
          h('button', {
            class: 'qs-btn qs-btn-ghost', type: 'button',
            onClick: () => openChoiceForm(option, draw, product.currencyCode),
          }, t('menu.add_choice')))),
      h('button', {
        class: 'qs-btn', type: 'button',
        onClick: () => openOptionForm(product, draw),
      }, t('menu.add_option')));
  };
  draw();
  return container;
}

function openOptionForm(product, redraw) {
  const form = h('form', {},
    languageNote(locales()),
    localisedField(t('common.name'), 'name', {}, { required: true }),
    h('div', { class: 'qs-grid qs-grid-2' },
      h('label', { class: 'qs-field' },
        h('span', {}, 'min'),
        h('input', { name: 'minSelect', type: 'number', min: '0', max: '20', value: '0' })),
      h('label', { class: 'qs-field' },
        h('span', {}, 'max'),
        h('input', { name: 'maxSelect', type: 'number', min: '1', max: '20', value: '1' }))),
    h('label', { class: 'qs-check' },
      h('input', { type: 'checkbox', name: 'required' }),
      h('span', {}, t('common.required'))));

  const dialog = modal({
    title: t('menu.add_option'),
    body: form,
    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());
          const created = await guard(() => api.post(`/api/menu/products/${product.id}/options`, {
            name: mergeLocalised({}, data, 'name'),
            required: data.required === 'on',
            minSelect: Number(data.minSelect ?? 0),
            maxSelect: Number(data.maxSelect ?? 1),
          }));
          if (!created) return;
          product.options.push(created);
          dialog.close();
          redraw();
        },
      }, t('common.save')),
    ],
  });
}

function openChoiceForm(option, redraw, productCurrencyCode) {
  // A choice's extra is in the dish's own currency: a "large" that costs 5 more
  // costs 5 of whatever the dish is priced in, so there is nothing to pick.
  const dishCurrency = currencyOf(productCurrencyCode);
  const delta = moneyField({
    label: `${t('common.price')} ±`,
    value: 0,
    currencies: [{ ...dishCurrency, isBase: true }],
    baseCurrency: dishCurrency,
    required: false,
  });

  const form = h('form', {},
    languageNote(locales()),
    localisedField(t('common.name'), 'name', {}, { required: true }),
    delta.node,
    h('label', { class: 'qs-check' },
      h('input', { type: 'checkbox', name: 'isDefault' }),
      h('span', {}, '★')));

  const dialog = modal({
    title: t('menu.add_choice'),
    body: form,
    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());
          const extra = delta.read();
          if (!delta.input.value.trim()) extra.minor = 0;
          else if (!delta.validate().ok) { delta.focus(); return; }

          const created = await guard(() => api.post(`/api/menu/options/${option.id}/choices`, {
            name: mergeLocalised({}, data, 'name'),
            priceDeltaMinor: extra.minor,
            isDefault: data.isDefault === 'on',
          }));
          if (!created) return;
          option.choices.push(created);
          dialog.close();
          redraw();
        },
      }, t('common.save')),
    ],
  });
}

/* --------------------------------------------------------------- addons */

function addonPanel() {
  return h('section', { class: 'qs-card', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
    h('div', { class: 'qs-card-head' },
      h('h3', { style: { margin: 0 } }, t('menu.addons')),
      canManage()
        ? h('button', { class: 'qs-btn qs-btn-ghost', onClick: () => openAddonForm(null) }, '+')
        : null),
    addons.length === 0
      ? h('p', { class: 'qs-muted qs-small' }, t('common.empty'))
      : h('div', { class: 'qs-row' }, addons.map((addon) =>
          h('button', {
            class: 'qs-btn qs-btn-ghost',
            onClick: () => canManage() && openAddonForm(addon),
          }, `${pick(addon.name)} · ${formatMoney(addon.priceMinor,
            displayed(currencyOf(addon.currencyCode), addon.currencyDisplay))}`))));
}

function openAddonForm(addon) {
  const price = moneyField({
    label: t('common.price'),
    value: addon?.priceMinor ?? 0,
    currencies,
    currencyCode: addon?.currencyCode ?? null,
    currencyDisplay: addon?.currencyDisplay ?? null,
  });

  const form = h('form', {},
    languageNote(locales()),
    localisedField(t('common.name'), 'name', addon?.name ?? {}, { required: true }),
    price.node,
    h('label', { class: 'qs-check' },
      h('input', { type: 'checkbox', name: 'available', checked: addon ? addon.available : true }),
      h('span', {}, t('common.enabled'))));

  const dialog = modal({
    title: addon ? pick(addon.name) : t('menu.add_addon'),
    body: form,
    actions: [
      addon
        ? h('button', {
            class: 'qs-btn qs-btn-danger', value: 'delete',
            onClick: async (event) => {
              event.preventDefault();
              await guard(() => api.del(`/api/menu/addons/${addon.id}`));
              dialog.close();
              await render(currentContainer);
            },
          }, t('common.delete'))
        : null,
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary', value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());
          const amount = price.validate();
          if (!amount.ok) { price.focus(); return; }

          const payload = {
            name: mergeLocalised(addon?.name ?? {}, data, 'name'),
            priceMinor: amount.minor,
            currencyCode: amount.currencyCode,
            currencyDisplay: amount.currencyDisplay,
            available: data.available === 'on',
          };
          const saved = await guard(() => addon
            ? api.patch(`/api/menu/addons/${addon.id}`, payload)
            : api.post('/api/menu/addons', payload));
          if (!saved) return;
          dialog.close();
          await render(currentContainer);
        },
      }, t('common.save')),
    ],
  });
}

/* --------------------------------------------------------------- render */

let currentContainer = null;

export async function renderMenuBuilder(container) {
  currentContainer = container;
  await load();

  mount(container,
    pageHeader(t('menu.builder'),
      h('a', {
        class: 'qs-btn', href: '/api/menu?includeHidden=false', target: '_blank', rel: 'noopener',
      }, t('menu.preview'))),

    h('div', { class: 'builder' }, categoryPanel(), productPanel()),
    addonPanel());
}

async function render(container) {
  if (container) await renderMenuBuilder(container);
  else await reroute();
}
