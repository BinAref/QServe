/**
 * Diner menu (spec §10, §41).
 *
 * Reached by scanning the QR on the table, so the table is already known — the
 * diner never picks one, and cannot order for a different table even by editing
 * the request, because the server binds the order to this terminal's table.
 *
 * The cart lives only in this page. Nothing is sent until "Send order", and
 * what is sent is product ids and quantities: prices are the server's business.
 */

import {
  boot, connectionIndicator, offlineBanner, guard, api, sound, toast, t, roleLabel, isRenamed,
} from '../shared/boot.js';
import { h, mount, modal, confirmDialog } from '../shared/dom.js';
import { formatMoney, pick, formatTime, availableLocales, setLocale, te } from '../shared/i18n.js';
import { SoundEvent } from '../shared/events.js';
import { displayed } from '../shared/money.js';

const state = {
  session: null,
  menu: null,
  categoryId: null,
  /** Cart lines: { key, product, quantity, selections, addons, notes } */
  cart: [],
  myOrders: [],
};

const root = document.getElementById('app');

/* --------------------------------------------------------------- pricing */

/**
 * Cart maths, for display only. The server recomputes everything on submit, so
 * a diner who tampers with this page changes nothing but their own screen.
 */
function linePrice(line) {
  const extras = line.selections.reduce((sum, s) => sum + s.priceDeltaMinor, 0)
    + line.addons.reduce((sum, a) => sum + a.priceMinor * a.quantity, 0);
  return (line.product.priceMinor + extras) * line.quantity;
}

const cartTotal = () => state.cart.reduce((sum, line) => sum + linePrice(line), 0);
const cartCount = () => state.cart.reduce((sum, line) => sum + line.quantity, 0);
const currency = () => state.menu?.restaurant?.currency;

/* ----------------------------------------------------------------- views */

function header() {
  const restaurant = state.menu?.restaurant;
  const tableId = state.session.terminal?.tableId;

  return h('header', { class: 'menu-header' },
    h('div', { class: 'menu-brand' },
      restaurant?.logoAssetId
        ? h('img', { class: 'menu-logo', src: `/assets/${restaurant.logoAssetId}`, alt: '' })
        : null,
      h('div', { class: 'qs-grow' },
        h('h1', { class: 'menu-title' }, pick(restaurant?.name) || t('app.name')),
        tableId
          ? h('div', { class: 'menu-table' }, `${t('orders.table')} ${tableId.replace(/^TABLE-/, '')}`)
          : null),
      languagePicker()));
}

function languagePicker() {
  const locales = availableLocales().filter((entry) => entry.enabled);
  if (locales.length < 2) return null;

  return h('select', {
    'aria-label': t('common.language'),
    style: { width: 'auto', minHeight: '40px' },
    onChange: async (event) => {
      await setLocale(event.target.value);
      render();
    },
  }, locales.map((entry) =>
    h('option', { value: entry.locale, selected: entry.locale === document.documentElement.lang },
      entry.name)));
}

function categoryStrip() {
  const categories = state.menu.categories;
  if (categories.length <= 1) return null;

  return h('nav', { class: 'menu-categories', role: 'tablist' },
    categories.map((category) =>
      h('button', {
        class: 'menu-chip',
        role: 'tab',
        'aria-selected': String(category.id === state.categoryId),
        onClick: () => {
          state.categoryId = category.id;
          render();
        },
      }, pick(category.name))));
}

/** The currency a price is in: the dish's own, or the restaurant's base. */
function currencyOf(code) {
  const list = state.menu?.currencies ?? [];
  return list.find((entry) => entry.code === code)
    ?? state.menu?.baseCurrency
    ?? currency();
}

function productCard(product) {
  const soldOut = !product.available;
  const showPrices = state.menu.display.showPrices;

  return h('button', {
    class: 'menu-item',
    disabled: soldOut,
    onClick: () => openProduct(product),
  },
    h('div', { class: 'menu-item-body' },
      h('div', { class: 'menu-item-name' }, pick(product.name)),
      pick(product.description)
        ? h('div', { class: 'menu-item-desc' }, pick(product.description))
        : null,
      soldOut ? h('div', { class: 'menu-sold-out' }, t('menu.sold_out')) : null,
      showPrices
        ? h('div', { class: 'menu-item-price' },
            formatMoney(product.priceMinor,
              displayed(currencyOf(product.currencyCode), product.currencyDisplay)))
        : null),
    state.menu.display.showImages && product.imageAssetId
      ? h('img', { class: 'menu-item-img', src: `/assets/${product.imageAssetId}`, alt: '', loading: 'lazy' })
      : null,
    // A dish with options costs "from" this price, not this price. Saying so on
    // the card avoids the small surprise of the sheet showing a bigger number.
    product.options.some((option) => option.choices.some((c) => c.priceDeltaMinor > 0))
      ? h('span', { class: 'menu-item-from' }, t('menu.from'))
      : null);
}

function productSection() {
  const category = state.menu.categories.find((entry) => entry.id === state.categoryId)
    ?? state.menu.categories[0];
  if (!category) return h('div', { class: 'qs-empty' }, t('common.empty'));

  const products = state.menu.products.filter((product) => product.categoryId === category.id);

  return h('section', { class: 'menu-section' },
    h('h2', {}, pick(category.name)),
    pick(category.description)
      ? h('p', { class: 'menu-section-note' }, pick(category.description))
      : null,
    products.length === 0
      ? h('div', { class: 'qs-empty' }, t('menu.empty_products'))
      // Staggered: the section reads as one thing arriving rather than twenty.
      : h('div', { class: 'menu-items qs-stagger' }, products.map(productCard)));
}

/* ------------------------------------------------------- product sheet */

/**
 * The item sheet. Required options are enforced here for a good experience and
 * again on the server for correctness — a diner cannot submit a burger with no
 * doneness chosen either way.
 */
function openProduct(product) {
  const draft = {
    product,
    quantity: 1,
    selections: [],
    addons: [],
    notes: null,
  };

  // Pre-select each option's default so a required option is usually answered.
  for (const option of product.options) {
    const preferred = option.choices.find((choice) => choice.isDefault && choice.available);
    if (preferred) {
      draft.selections.push({
        optionId: option.id,
        choiceId: preferred.id,
        name: preferred.name,
        priceDeltaMinor: preferred.priceDeltaMinor,
      });
    }
  }

  const priceOut = h('output', {}, '');
  const addButton = h('button', {
    class: 'qs-btn qs-btn-primary qs-btn-lg qs-btn-block',
    value: 'add',
    onClick: (event) => {
      const missing = product.options.filter((option) =>
        option.required && !draft.selections.some((s) => s.optionId === option.id));
      if (missing.length > 0) {
        event.preventDefault();
        toast(`${t('common.required')}: ${pick(missing[0].name)}`, 'warning');
        return;
      }
      addToCart(draft);
    },
  }, t('menu.add_to_order'));

  const refreshPrice = () => {
    priceOut.textContent = formatMoney(linePrice(draft), currency());
    addButton.textContent = `${t('menu.add_to_order')} · ${formatMoney(linePrice(draft), currency())}`;
  };

  const optionBlocks = product.options.map((option) => {
    const single = option.maxSelect <= 1;
    return h('div', {},
      h('div', { class: 'qs-section-title' },
        pick(option.name),
        option.required ? ` · ${t('common.required')}` : '',
        !single ? ` · ${t('menu.max_select', { count: option.maxSelect })}` : ''),
      option.choices.map((choice) =>
        h('label', { class: 'menu-choice' },
          h('input', {
            type: single ? 'radio' : 'checkbox',
            name: `opt-${option.id}`,
            disabled: !choice.available,
            checked: draft.selections.some((s) => s.choiceId === choice.id),
            onChange: (event) => {
              if (single) {
                draft.selections = draft.selections.filter((s) => s.optionId !== option.id);
              } else if (!event.target.checked) {
                draft.selections = draft.selections.filter((s) => s.choiceId !== choice.id);
              } else if (draft.selections.filter((s) => s.optionId === option.id).length >= option.maxSelect) {
                event.target.checked = false;
                toast(t('menu.max_select', { count: option.maxSelect }), 'warning');
                return;
              }
              if (event.target.checked || single) {
                draft.selections.push({
                  optionId: option.id,
                  choiceId: choice.id,
                  name: choice.name,
                  priceDeltaMinor: choice.priceDeltaMinor,
                });
              }
              refreshPrice();
            },
          }),
          h('span', {}, pick(choice.name)),
          choice.priceDeltaMinor !== 0
            ? h('span', { class: 'menu-choice-price' },
                `+${formatMoney(choice.priceDeltaMinor, currency())}`)
            : null)));
  });

  const addonBlock = product.addons.length > 0
    ? h('div', {},
        h('div', { class: 'qs-section-title' }, t('menu.addons')),
        product.addons.map((addon) =>
          h('label', { class: 'menu-choice' },
            h('input', {
              type: 'checkbox',
              disabled: !addon.available,
              onChange: (event) => {
                draft.addons = event.target.checked
                  ? [...draft.addons, { addonId: addon.id, name: addon.name, priceMinor: addon.priceMinor, quantity: 1 }]
                  : draft.addons.filter((entry) => entry.addonId !== addon.id);
                refreshPrice();
              },
            }),
            h('span', {}, pick(addon.name)),
            h('span', { class: 'menu-choice-price' }, `+${formatMoney(addon.priceMinor, currency())}`))))
    : null;

  const quantityRow = h('div', { class: 'menu-qty' },
    h('button', {
      type: 'button', 'aria-label': '-',
      onClick: () => {
        draft.quantity = Math.max(1, draft.quantity - 1);
        quantityRow.querySelector('output').textContent = String(draft.quantity);
        refreshPrice();
      },
    }, '−'),
    h('output', {}, String(draft.quantity)),
    h('button', {
      type: 'button', 'aria-label': '+',
      onClick: () => {
        draft.quantity = Math.min(99, draft.quantity + 1);
        quantityRow.querySelector('output').textContent = String(draft.quantity);
        refreshPrice();
      },
    }, '+'));

  const dialog = modal({
    title: pick(product.name),
    body: h('div', {},
      state.menu.display.showImages && product.imageAssetId
        ? h('img', {
            src: `/assets/${product.imageAssetId}`, alt: '',
            style: { width: '100%', borderRadius: 'var(--qs-radius-md)', marginBlockEnd: 'var(--qs-spacing-md)' },
          })
        : null,
      pick(product.description) ? h('p', { class: 'qs-muted' }, pick(product.description)) : null,
      optionBlocks,
      addonBlock,
      state.menu.display.showPrices === false ? null : h('div', { class: 'qs-section-title' }, t('common.quantity')),
      quantityRow,
      h('label', { class: 'qs-field', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
        h('span', {}, t('menu.item_notes')),
        h('textarea', {
          maxlength: '500',
          placeholder: t('menu.item_notes'),
          onInput: (event) => { draft.notes = event.target.value.trim() || null; },
        }))),
    actions: [addButton],
  });

  refreshPrice();
  return dialog;
}

function addToCart(draft) {
  state.cart.push({ key: crypto.randomUUID(), ...draft });
  toast(`${pick(draft.product.name)} · ${t('common.add')}`, 'success');
  render();
}

/* ------------------------------------------------- asking for a person */

/**
 * The two things a diner asks for that are not food.
 *
 * They sit under the menu rather than in the header because that is where a
 * thumb is while scrolling, and they confirm in place — a diner who taps twice
 * because nothing visibly happened is a waiter called twice.
 */
function serviceButtons() {
  if (!state.session.terminal) return null;

  const ask = async (kind, node, done) => {
    node.dataset.busy = 'true';
    const sent = await guard(() => notifications.raise(kind));
    node.dataset.busy = 'false';
    if (!sent) return;

    node.disabled = true;
    node.classList.add('qs-attention');
    toast(done, 'success');
    sound.playFor('new_order');
    // Long enough that nobody taps again, short enough to ask twice if the
    // waiter genuinely has not come.
    setTimeout(() => {
      node.disabled = false;
      node.classList.remove('qs-attention');
    }, 60_000);
  };

  // The button says what this restaurant calls the person it fetches. Until
  // somebody renames the role, the shipped sentence is the better one — "Call a
  // waiter" reads more naturally than "Call Waiter" — so it stays.
  const role = roleLabel('WAITER');
  const named = isRenamed('WAITER');
  const callLabel = named ? t('notify.call_role', { role }) : t('notify.call_waiter');
  const onTheWay = named ? t('notify.called_role', { role }) : t('notify.called');

  const call = h('button', { class: 'qs-btn qs-btn-lg' }, '🔔 ', callLabel);
  call.addEventListener('click', () => void ask('WAITER_CALLED', call, onTheWay));

  const bill = h('button', { class: 'qs-btn qs-btn-lg' }, '🧾 ', t('notify.ask_for_bill'));
  bill.addEventListener('click', () => void ask('BILL_REQUESTED', bill, onTheWay));

  return h('div', { class: 'menu-service' }, call, bill);
}

/* ------------------------------------------------------------------ cart */

function cartBar() {
  if (state.cart.length === 0) {
    return state.myOrders.length > 0 ? orderStatusBar() : null;
  }

  return h('div', { class: 'menu-cart-bar' },
    h('button', {
      class: 'qs-btn qs-btn-primary qs-btn-lg qs-btn-block',
      onClick: openCart,
    },
      h('span', { class: 'qs-grow' }, `${t('menu.your_order')} · ${cartCount()}`),
      h('span', {}, formatMoney(cartTotal(), currency()))));
}

function openCart() {
  const body = h('div', {});

  const draw = () => {
    mount(body,
      state.cart.length === 0
        ? h('div', { class: 'qs-empty' }, t('menu.cart_empty'))
        : state.cart.map((line) =>
            h('div', { class: 'menu-line' },
              h('span', { class: 'menu-line-qty' }, `${line.quantity}×`),
              h('div', { class: 'qs-grow' },
                h('div', {}, pick(line.product.name)),
                line.selections.map((selection) =>
                  h('div', { class: 'qs-xs qs-muted' }, `· ${pick(selection.name)}`)),
                line.addons.map((addon) =>
                  h('div', { class: 'qs-xs qs-muted' }, `+ ${pick(addon.name)}`)),
                line.notes ? h('div', { class: 'qs-xs qs-muted' }, `“${line.notes}”`) : null),
              h('span', { class: 'menu-line-total' }, formatMoney(linePrice(line), currency())),
              h('button', {
                class: 'qs-icon-btn',
                'aria-label': t('common.delete'),
                type: 'button',
                onClick: () => {
                  state.cart = state.cart.filter((entry) => entry.key !== line.key);
                  draw();
                  render();
                },
              }, '×'))),
      state.cart.length > 0
        ? h('div', { class: 'qs-row qs-row-between', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
            h('strong', {}, t('common.total')),
            h('strong', {}, formatMoney(cartTotal(), currency())))
        : null,
      state.cart.length > 0
        ? h('label', { class: 'qs-field', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
            h('span', {}, t('common.notes')),
            h('textarea', {
              id: 'order-notes', maxlength: '1000',
              placeholder: t('menu.item_notes'),
            }))
        : null);
  };
  draw();

  const send = h('button', {
    class: 'qs-btn qs-btn-primary',
    value: 'send',
    onClick: (event) => {
      event.preventDefault();
      void submitOrder(document.getElementById('order-notes')?.value ?? null, dialog);
    },
  }, t('menu.send_order'));

  const dialog = modal({
    title: t('menu.your_order'),
    body,
    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.close')),
      send,
    ],
  });
  return dialog;
}

async function submitOrder(notes, dialog) {
  const payload = {
    notes: notes || null,
    items: state.cart.map((line) => ({
      productId: line.product.id,
      quantity: line.quantity,
      selections: line.selections.map((s) => ({ optionId: s.optionId, choiceId: s.choiceId })),
      addons: line.addons.map((a) => ({ addonId: a.addonId, quantity: a.quantity })),
      notes: line.notes,
    })),
  };

  const order = await guard(() => api.post('/api/orders', payload));
  if (!order) return;

  state.cart = [];
  state.myOrders.unshift(order);
  dialog.close();
  sound.playFor(SoundEvent.NOTIFICATION);

  /*
   * What the diner is told depends on what this restaurant actually has. With
   * a till watching, the order has landed somewhere and nothing is asked of
   * them. With only a waiter, somebody has to be fetched — so they are told to,
   * plainly, rather than waiting for food nobody knows about.
   */
  const plan = state.plan ?? {};
  const afterOrder = plan.afterOrderKey ?? 'menu.order_sent';
  toast(t(
    afterOrder === 'orders.placed_call_waiter' && isRenamed('WAITER')
      ? 'orders.placed_call_role'
      : afterOrder,
    { role: roleLabel('WAITER') },
  ), 'success');
  if (plan.callWaiterAfterOrder) {
    // And the ask is made for them, so "call a waiter" is a fact rather than
    // an instruction they have to carry out.
    void guard(() => notifications.raise('WAITER_CALLED', { orderId: order.id }));
  }
  render();
}

/* ---------------------------------------------------------- order status */

/**
 * The steps a diner is shown.
 *
 * READY only appears where a kitchen exists to call it: in a restaurant with
 * one computer, a five-step tracker that can only ever reach three would look
 * like something had gone wrong.
 */
function trackSteps() {
  const usesReady = state.plan?.usesReady !== false;
  return usesReady
    ? ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED']
    : ['NEW', 'PREPARING', 'SERVED'];
}

const STEP_KEYS = {
  NEW: 'orders.step_placed',
  ACCEPTED: 'orders.step_accepted',
  PREPARING: 'orders.step_preparing',
  READY: 'orders.step_ready',
  SERVED: 'orders.step_served',
  PAID: 'orders.step_paid',
};

function orderStatusBar() {
  const order = state.myOrders[0];
  if (!order) return null;

  const track = trackSteps();
  // ACCEPTED collapses into PREPARING where there is no kitchen, so an order
  // that skipped it still shows as under way rather than nowhere.
  const effective = track.includes(order.status)
    ? order.status
    : order.status === 'ACCEPTED' ? 'PREPARING' : order.status;
  const reached = track.indexOf(effective);

  return h('div', { class: 'menu-cart-bar' },
    h('div', { class: 'qs-row qs-row-between' },
      h('strong', {}, t('orders.order_number', { number: order.number })),
      h('span', { class: 'qs-badge' },
        t(STEP_KEYS[order.status] ?? 'orders.status.' + order.status.toLowerCase()))),

    h('div', { class: 'menu-track', style: { marginBlock: 'var(--qs-spacing-sm)' } },
      track.map((step, index) => h('span', {
        'data-done': String(index <= reached),
        // The step being worked on right now pulses, so a diner watching the
        // bar can see the restaurant is doing something.
        'data-current': String(index === reached),
        title: t(STEP_KEYS[step] ?? step),
      }))),

    h('div', { class: 'qs-row qs-row-between qs-small qs-muted' },
      h('span', {}, formatTime(order.createdAt)),
      h('span', {}, formatMoney(order.totals.totalMinor, order.currency))),
    cancellable(order));
}

/**
 * A diner may cancel their own order for a short window (spec §18). After that
 * the kitchen may already have started, so the button disappears and they are
 * told to ask a waiter — which is what the server would enforce anyway.
 */
function cancellable(order) {
  if (order.status !== 'NEW') return null;
  const ageSeconds = (Date.now() - new Date(order.createdAt).getTime()) / 1000;
  if (ageSeconds > 120) return null;

  return h('button', {
    class: 'qs-btn qs-btn-danger qs-btn-block',
    style: { marginBlockStart: 'var(--qs-spacing-sm)' },
    onClick: async () => {
      const ok = await confirmDialog({
        title: t('orders.action.cancel'),
        message: t('orders.order_number', { number: order.number }),
        confirmLabel: t('orders.action.cancel'),
        cancelLabel: t('common.cancel'),
      });
      if (!ok) return;
      const updated = await guard(() => api.post(`/api/orders/${order.id}/cancel-by-customer`));
      if (updated) {
        state.myOrders = state.myOrders.map((entry) => (entry.id === updated.id ? updated : entry));
        render();
      }
    },
  }, t('orders.action.cancel'));
}

/* ---------------------------------------------------------------- render */

function render() {
  mount(root,
    offlineBanner(realtime),
    header(),
    categoryStrip(),
    productSection(),
    serviceButtons(),
    cartBar());
}

/* ------------------------------------------------------------------ boot */

let realtime;
let notifications;

async function main() {
  // Re-fetching without repainting would leave a diner reading a stale menu
  // after every reconnection, so a resync ends in a render like everything else.
  const started = await boot({
    topics: ['menu', 'orders', 'system'],
    onResync: () => void reload().then(render),
  });
  state.session = started.session;
  realtime = started.realtime;
  notifications = started.notifications;
  // What this restaurant has decides what the diner is told and shown.
  state.plan = (await api.get('/api/system').catch(() => null))?.servicePlan ?? null;

  await reload();
  render();

  // A price or availability change reaches every table without a refresh.
  realtime.on('menu.updated', () => void reload().then(render));

  // Only this table's own orders matter to this phone.
  const mine = (order) => state.myOrders.some((entry) => entry.id === order.id);
  realtime.on('order.status_changed', ({ order }) => {
    if (!mine(order)) return;
    state.myOrders = state.myOrders.map((entry) => (entry.id === order.id ? order : entry));
    if (order.status === 'READY') sound.playFor(SoundEvent.ORDER_READY);
    render();
  });

  document.title = pick(state.menu?.restaurant?.name) || t('app.name');
}

async function reload() {
  state.menu = await api.get('/api/menu');
  if (!state.categoryId && state.menu.categories.length > 0) {
    state.categoryId = state.menu.categories[0].id;
  }

  // Show this table's open orders, so a diner returning to the page still sees
  // what they ordered ten minutes ago.
  const tableId = state.session.terminal?.tableId;
  if (tableId) {
    const result = await api
      .get(`/api/orders?tableId=${encodeURIComponent(tableId)}&open=true`)
      .catch(() => ({ orders: [] }));
    state.myOrders = result.orders;
  }
}

void main().catch((error) => console.error('[menu]', error));
