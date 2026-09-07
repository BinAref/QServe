/**
 * Waiter terminal (spec §11, §12, §42).
 *
 * A waiter thinks in tables, so the floor is the home screen: every table, its
 * live status, and what it is waiting for. Picking a table opens the menu and
 * builds an order *for that table* — recorded with `Source: WAITER` and the
 * waiter's own name, which is the distinction the spec is most insistent about.
 */

import { boot, connectionIndicator, offlineBanner, guard, api, sound, toast, t, roleLabel } from '../shared/boot.js';
import { h, mount, modal } from '../shared/dom.js';
import { formatMoney, pick, te } from '../shared/i18n.js';
import { SoundEvent, OrderStatus, grants, Permission } from '../shared/events.js';

const state = {
  session: null,
  tables: [],
  menu: null,
  /** Order being built: { tableId, lines: [...] } */
  draft: null,
};

const root = document.getElementById('app');
let realtime;
let notifications;

const signedIn = () => state.session.user !== null;
const currency = () => state.menu?.restaurant?.currency;

/* ------------------------------------------------------------------ data */

async function reload() {
  const result = await api.get('/api/waiter/tables').catch(() => null);
  if (result) state.tables = result.tables;
  render();
}

async function refreshSession() {
  state.session = await api.get('/api/auth/me');
}

/* ---------------------------------------------------------------- header */

function header() {
  return h('header', { class: 'floor-head' },
    // Whatever this restaurant calls the people who work here.
    h('h1', {}, roleLabel('WAITER')),
    state.session.terminal
      ? h('span', { class: 'qs-badge' }, pick(state.session.terminal.name))
      : null,
    h('span', { class: 'qs-grow' }),

    signedIn()
      ? h('div', { class: 'qs-row' },
          h('span', { class: 'qs-badge qs-badge-success' }, state.session.user.displayName),
          h('button', {
            class: 'qs-btn qs-btn-ghost',
            onClick: async () => {
              await api.post('/api/auth/logout');
              await refreshSession();
              render();
            },
          }, t('common.signout')))
      : h('button', { class: 'qs-btn qs-btn-primary', onClick: openSignIn }, t('common.signin')),

    notifications.bell(),
    connectionIndicator(realtime));
}

function openSignIn() {
  const dialog = modal({
    title: t('common.signin'),
    body: h('div', {},
      // Signing in is what makes an order attributable to a named waiter.
      h('p', { class: 'qs-muted' }, t('orders.created_by')),
      h('label', { class: 'qs-field' },
        h('span', {}, t('common.username')),
        h('input', { id: 'w-user', autocomplete: 'username' })),
      h('label', { class: 'qs-field' },
        h('span', {}, t('common.pin')),
        h('input', { id: 'w-pin', type: 'password', inputmode: 'numeric' }))),
    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'ok',
        onClick: async (event) => {
          event.preventDefault();
          const result = await guard(() => api.post('/api/auth/login', {
            username: document.getElementById('w-user').value.trim(),
            password: document.getElementById('w-pin').value,
          }));
          if (!result) return;
          await refreshSession();
          dialog.close();
          render();
        },
      }, t('common.signin')),
    ],
  });
  setTimeout(() => document.getElementById('w-user')?.focus(), 50);
}

/* ------------------------------------------------------------------ floor */

function floor() {
  if (state.tables.length === 0) {
    return h('div', { class: 'qs-empty' }, t('common.empty'));
  }

  // The tables arrive as one thing rather than twenty, which is what makes a
  // board glanced at from across a room readable rather than busy.
  return h('div', { class: 'floor-grid qs-stagger' }, state.tables.map((table) => {
    const ready = table.openOrders.filter((order) => order.status === OrderStatus.READY).length;

    return h('button', {
      class: 'floor-table',
      'data-status': table.status,
      // Food waiting is the one thing on this screen that must not be scrolled
      // past, so the card itself keeps asking rather than a badge inside it.
      'data-ready': String(ready > 0),
      onClick: () => openTable(table),
    },
      h('span', { class: 'floor-label' }, table.label),
      // The status line is dropped when the flag below already says it, rather
      // than printing "Ready" twice on the same card.
      ready > 0
        ? h('span', { class: 'floor-ready-flag' },
            t('waiter.plates_ready', { count: ready }))
        : h('span', { class: 'floor-status' }, te('tables.status', table.status)),
      h('span', { class: 'floor-count qs-muted' },
        table.openOrders.length > 0
          ? t('tables.open_count', { count: table.openOrders.length })
          : t('tables.seat_count', { count: table.seats })));
  }));
}

function openTable(table) {
  const body = h('div', {},
    table.openOrders.length === 0
      ? h('p', { class: 'qs-muted' }, t('orders.no_orders'))
      : h('div', { class: 'waiter-order-list' }, table.openOrders.map((order) =>
          h('div', { class: 'waiter-order' },
            h('div', { class: 'qs-row qs-row-between' },
              h('strong', {}, t('orders.order_number', { number: order.number })),
              h('span', { class: 'qs-badge' }, te('orders.status', order.status))),
            h('div', { class: 'qs-small qs-muted' },
              `${t('orders.source')}: ${te('orders.source', order.source)}`,
              order.createdBy.userName ? ` — ${order.createdBy.userName}` : ''),
            h('div', { class: 'qs-small' }, order.items.map((item) =>
              h('div', {}, `${item.quantity}× ${pick(item.name)}`))),
            h('div', { class: 'qs-row qs-row-between', style: { marginBlockStart: 'var(--qs-spacing-sm)' } },
              h('span', {}, formatMoney(order.totals.totalMinor, order.currency)),
              h('div', { class: 'qs-row' },
                rushButton(order),
                serveButton(order)))))));

  const dialog = modal({
    title: table.label,
    body,
    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.close')),
      grants(state.session.permissions, Permission.ORDERS_CREATE)
        ? h('button', {
            class: 'qs-btn qs-btn-primary',
            value: 'new',
            onClick: (event) => {
              event.preventDefault();
              dialog.close();
              void openOrderBuilder(table);
            },
          }, t('orders.new_order'))
        : null,
    ],
  });
  return dialog;
}

/**
 * Ask the kitchen to hurry a specific ticket.
 *
 * Only offered while the food is still being made — asking for speed on a
 * ticket that is already up would just be noise at the pass. It spends itself
 * for a minute afterwards, because asking twice does not make it faster.
 */
function rushButton(order) {
  if (order.status !== OrderStatus.ACCEPTED && order.status !== OrderStatus.PREPARING) {
    return null;
  }

  const button = h('button', { class: 'qs-btn qs-btn-sm' }, t('notify.rush'));
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    const sent = await guard(() => notifications.raise('ORDER_RUSHED', {
      orderId: order.id,
      params: { order: order.number },
    }));
    if (!sent) return;
    button.disabled = true;
    toast(t('notify.rush'), 'success');
    setTimeout(() => { button.disabled = false; }, 60_000);
  });
  return button;
}

function serveButton(order) {
  if (order.status !== OrderStatus.READY) return null;
  if (!grants(state.session.permissions, Permission.ORDERS_CHANGE_STATUS)) return null;

  return h('button', {
    class: 'qs-btn qs-btn-primary',
    onClick: async (event) => {
      event.preventDefault();
      const done = await guard(() =>
        api.post(`/api/orders/${order.id}/status`, { status: OrderStatus.SERVED }));
      if (done) {
        toast(te('orders.status', OrderStatus.SERVED), 'success');
        await reload();
        document.querySelector('dialog[open]')?.close();
      }
    },
  }, t('orders.action.mark_served'));
}

/* ---------------------------------------------------------- order builder */

async function openOrderBuilder(table) {
  if (!state.menu) state.menu = await api.get('/api/menu');
  state.draft = { tableId: table.id, lines: [] };

  const listNode = h('div', {});
  const totalNode = h('strong', {}, formatMoney(0, currency()));

  const redrawDraft = () => {
    const total = state.draft.lines.reduce((sum, line) => sum + line.priceMinor * line.quantity, 0);
    totalNode.textContent = formatMoney(total, currency());
    mount(listNode,
      state.draft.lines.length === 0
        ? h('p', { class: 'qs-muted' }, t('menu.cart_empty'))
        : state.draft.lines.map((line, index) =>
            h('div', { class: 'qs-row qs-row-between', style: { paddingBlock: '6px' } },
              h('span', {}, `${line.quantity}× ${line.label}`),
              h('span', { class: 'qs-row' },
                h('span', {}, formatMoney(line.priceMinor * line.quantity, currency())),
                h('button', {
                  class: 'qs-icon-btn',
                  type: 'button',
                  'aria-label': t('common.delete'),
                  onClick: () => {
                    state.draft.lines.splice(index, 1);
                    redrawDraft();
                  },
                }, '×')))));
  };
  redrawDraft();

  const products = state.menu.products.filter((product) => product.available);

  const dialog = modal({
    title: t('waiter.new_order_for', { table: table.label }),
    body: h('div', {},
      h('div', { class: 'qs-section-title' }, t('menu.products')),
      h('div', { class: 'qs-grid qs-grid-3' }, products.map((product) =>
        h('button', {
          class: 'qs-btn',
          type: 'button',
          onClick: () => {
            addLine(product);
            redrawDraft();
          },
        }, `${pick(product.name)} · ${formatMoney(product.priceMinor, currency())}`))),

      h('div', { class: 'qs-section-title' }, t('menu.your_order')),
      listNode,
      h('div', { class: 'qs-row qs-row-between' }, h('span', {}, t('common.total')), totalNode),

      h('label', { class: 'qs-field', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
        h('span', {}, t('common.notes')),
        h('textarea', { id: 'w-notes', maxlength: '1000' }))),
    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'send',
        onClick: async (event) => {
          event.preventDefault();
          if (state.draft.lines.length === 0) {
            toast(t('menu.cart_empty'), 'warning');
            return;
          }
          const order = await guard(() => api.post('/api/orders', {
            tableId: state.draft.tableId,
            notes: document.getElementById('w-notes')?.value.trim() || null,
            items: state.draft.lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              selections: line.selections,
              addons: [],
              notes: null,
            })),
          }));
          if (!order) return;
          dialog.close();
          sound.playFor(SoundEvent.NOTIFICATION);
          toast(t('orders.order_number', { number: order.number }), 'success');
          await reload();
        },
      }, t('menu.send_order')),
    ],
  });
}

/**
 * Add a product to the draft. Required options are answered with their default
 * (or first available) choice so a waiter can build an order in single taps;
 * anything genuinely ambiguous is still validated by the server.
 */
function addLine(product) {
  const selections = [];
  let extraMinor = 0;

  for (const option of product.options) {
    if (!option.required) continue;
    const choice = option.choices.find((entry) => entry.isDefault && entry.available)
      ?? option.choices.find((entry) => entry.available);
    if (choice) {
      selections.push({ optionId: option.id, choiceId: choice.id });
      extraMinor += choice.priceDeltaMinor;
    }
  }

  const key = `${product.id}:${selections.map((s) => s.choiceId).join(',')}`;
  const existing = state.draft.lines.find((line) => line.key === key);
  if (existing) {
    existing.quantity += 1;
    return;
  }

  state.draft.lines.push({
    key,
    productId: product.id,
    label: pick(product.name),
    priceMinor: product.priceMinor + extraMinor,
    quantity: 1,
    selections,
  });
}

/* ---------------------------------------------------------------- render */

function render() {
  mount(root,
    offlineBanner(realtime),
    // A waiter carrying plates looks at the top of the screen, not at a bell in
    // a corner, so the urgent one gets a band of its own.
    notifications.banner(),
    header(),
    floor());
}

async function main() {
  const started = await boot({
    topics: ['waiter', 'tables', 'orders', 'menu', 'system'],
    requireTerminal: true,
    onResync: () => void reload(),
  });
  state.session = started.session;
  realtime = started.realtime;
  notifications = started.notifications;
  // Anything arriving redraws the header count and the banner in place.
  notifications.onChange(() => {
    document.querySelector('.qs-notify-banner')?.replaceWith(notifications.banner());
  });

  await reload();

  realtime.on('table.status_changed', () => void reload());
  realtime.on('order.created', () => void reload());
  realtime.on('order.items_changed', () => void reload());

  realtime.on('order.status_changed', ({ order }) => {
    // "Table 5 is ready" is the one thing a waiter must not miss.
    if (order.status === OrderStatus.READY) {
      sound.playFor(SoundEvent.ORDER_READY);
      toast(t('waiter.ready_alert', { number: order.number }), 'success');
    }
    if (order.status === OrderStatus.CANCELLED) sound.playFor(SoundEvent.ORDER_CANCELLED);
    void reload();
  });

  // The menu may change mid-shift; drop the cache so the next order is priced
  // from what the kitchen can actually cook.
  realtime.on('menu.updated', () => { state.menu = null; });
}

void main().catch((error) => console.error('[waiter]', error));
