/**
 * Cashier terminal (spec §14, §15, §43).
 *
 * The rule the whole screen is built around: **a payment names a person**. The
 * station identifies the till; a cashier signs in with their PIN, and every
 * capture records both. The sign-in panel is therefore not a nicety — until
 * someone signs in, the payment buttons are simply not there, matching the
 * server, which refuses the request without an identified user.
 */

import { boot, connectionIndicator, offlineBanner, guard, api, sound, toast, t, roleLabel } from '../shared/boot.js';
import { h, mount, modal, confirmDialog } from '../shared/dom.js';
import { formatMoney, pick, te, formatTime } from '../shared/i18n.js';
import { SoundEvent, OrderStatus, PaymentMethod, grants, Permission } from '../shared/events.js';

const state = {
  session: null,
  orders: [],
  selectedId: null,
  /** Amount being typed on the keypad, in minor units. */
  amountMinor: 0,
};

const root = document.getElementById('app');
let realtime;
let notifications;

const selected = () => state.orders.find((entry) => entry.order.id === state.selectedId) ?? null;
const currency = () => selected()?.order.currency ?? state.orders[0]?.order.currency;
const signedIn = () => state.session.user !== null;

/* ------------------------------------------------------------------ data */

async function reload() {
  const result = await api.get('/api/cashier/orders').catch(() => null);
  if (!result) return;

  state.orders = result.orders;
  if (!state.orders.some((entry) => entry.order.id === state.selectedId)) {
    state.selectedId = state.orders[0]?.order.id ?? null;
    state.amountMinor = selected()?.bill.outstandingMinor ?? 0;
  }
  render();
}

async function refreshSession() {
  state.session = await api.get('/api/auth/me');
}

/* ----------------------------------------------------------------- views */

function header() {
  return h('header', { class: 'till-head' },
    // Only visible on a phone, where the bill covers the list.
    h('button', {
      class: 'qs-icon-btn till-back',
      'aria-label': t('common.back'),
      onClick: () => { state.selectedId = null; render(); },
    }, '‹'),

    // Whatever this restaurant calls the people who work here.
    h('h1', {}, roleLabel('CASHIER')),
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
  const form = h('div', {},
    h('p', { class: 'qs-muted' }, t('cashier.sign_in_required')),
    h('label', { class: 'qs-field' },
      h('span', {}, t('common.username')),
      h('input', { id: 'till-user', autocomplete: 'username' })),
    h('label', { class: 'qs-field' },
      h('span', {}, t('common.pin')),
      h('input', { id: 'till-pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password' })));

  const dialog = modal({
    title: t('common.signin'),
    body: form,
    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'signin',
        onClick: async (event) => {
          event.preventDefault();
          const username = document.getElementById('till-user').value.trim();
          const password = document.getElementById('till-pin').value;
          const result = await guard(() => api.post('/api/auth/login', { username, password }));
          if (!result) return;
          await refreshSession();
          dialog.close();
          render();
        },
      }, t('common.signin')),
    ],
  });
  setTimeout(() => document.getElementById('till-user')?.focus(), 50);
}

function orderList() {
  return h('aside', { class: 'till-list' },
    state.orders.length === 0
      ? h('div', { class: 'qs-empty' }, t('orders.no_orders'))
      : state.orders.map(({ order, bill }) =>
          h('button', {
            class: 'till-order',
            'aria-current': String(order.id === state.selectedId),
            onClick: () => {
              state.selectedId = order.id;
              state.amountMinor = bill.outstandingMinor;
              render();
            },
          },
            h('div', { class: 'till-order-top' },
              h('span', { class: 'till-order-num' }, `#${order.number}`),
              h('span', {}, order.tableLabel ?? '—'),
              h('span', { class: 'till-order-total' },
                formatMoney(order.totals.totalMinor, order.currency))),
            h('div', { class: 'qs-row qs-small qs-muted' },
              h('span', { class: 'qs-badge' }, te('orders.status', order.status)),
              h('span', {}, formatTime(order.createdAt)),
              bill.outstandingMinor === 0
                ? h('span', { class: 'till-settled' }, te('payments.status', 'CAPTURED'))
                : null))));
}

function detail() {
  const entry = selected();
  if (!entry) {
    return h('div', { class: 'till-detail till-bill' },
      h('div', { class: 'qs-empty' }, t('orders.no_orders')));
  }

  const { order, bill } = entry;

  return h('section', { class: 'till-detail till-bill' },
    h('div', { class: 'qs-card-head' },
      h('div', {},
        h('h2', {}, t('orders.order_number', { number: order.number })),
        h('div', { class: 'qs-muted qs-small' },
          `${t('orders.table')} ${order.tableLabel ?? '—'} · `,
          `${t('orders.source')}: ${te('orders.source', order.source)}`,
          order.createdBy.userName ? ` — ${order.createdBy.userName}` : '')),
      h('span', { class: 'qs-badge' }, te('orders.status', order.status))),

    h('div', { class: 'till-lines' }, order.items.map((item) =>
      h('div', { class: 'till-line' },
        h('span', { class: 'qs-strong' }, `${item.quantity}×`),
        h('div', { class: 'qs-grow' },
          h('div', {}, pick(item.name)),
          item.selections.map((selection) =>
            h('div', { class: 'qs-xs qs-muted' }, `· ${pick(selection.name)}`)),
          item.addons.map((addon) =>
            h('div', { class: 'qs-xs qs-muted' }, `+ ${addon.quantity} ${pick(addon.name)}`))),
        h('span', { class: 'till-line-total' }, formatMoney(item.lineTotalMinor, order.currency))))),

    h('div', { class: 'till-totals' },
      h('div', {}, h('span', {}, t('common.subtotal')),
        h('span', {}, formatMoney(order.totals.subtotalMinor, order.currency))),
      order.totals.discountMinor > 0
        ? h('div', {}, h('span', {}, t('payments.discount')),
            h('span', {}, `−${formatMoney(order.totals.discountMinor, order.currency)}`))
        : null,
      order.totals.serviceMinor > 0
        ? h('div', {}, h('span', {}, t('payments.service')),
            h('span', {}, formatMoney(order.totals.serviceMinor, order.currency)))
        : null,
      order.totals.taxMinor > 0
        ? h('div', {}, h('span', {}, t('payments.tax')),
            h('span', {}, formatMoney(order.totals.taxMinor, order.currency)))
        : null,
      h('div', { class: 'till-grand' },
        h('span', {}, t('common.total')),
        h('span', {}, formatMoney(order.totals.totalMinor, order.currency))),
      bill.capturedMinor > 0
        ? h('div', {}, h('span', { class: 'qs-muted' }, t('payments.title')),
            h('span', {}, formatMoney(bill.capturedMinor, order.currency)))
        : null,
      h('div', { class: bill.outstandingMinor > 0 ? 'till-outstanding qs-strong' : 'till-settled qs-strong' },
        h('span', {}, t('cashier.outstanding')),
        h('span', {}, formatMoney(bill.outstandingMinor, order.currency)))),

    paymentPanel(entry),
    paymentHistory(bill),
    orderActions(order, bill));
}

/**
 * The keypad. Absent entirely when nobody is signed in — the server would
 * refuse the capture, and a button that always fails is worse than no button.
 */
function paymentPanel({ order, bill }) {
  if (bill.outstandingMinor === 0) return null;

  if (!signedIn()) {
    return h('div', { class: 'qs-locked', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
      h('p', { class: 'qs-strong' }, t('cashier.sign_in_required')),
      h('button', { class: 'qs-btn qs-btn-primary', onClick: openSignIn }, t('common.signin')));
  }
  if (!grants(state.session.permissions, Permission.PAYMENTS_CREATE)) {
    return h('div', { class: 'qs-locked' }, t('error.forbidden'));
  }

  const decimals = order.currency.decimals;
  const press = (digit) => {
    state.amountMinor = Math.min(state.amountMinor * 10 + digit, 1_000_000_000);
    render();
  };

  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) =>
    h('button', { class: 'qs-btn', onClick: () => press(digit) }, String(digit)));

  return h('div', { class: 'qs-card', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
    h('h3', {}, t('cashier.take_payment')),
    h('div', { class: 'till-amount' }, formatMoney(state.amountMinor, order.currency)),

    h('div', { class: 'till-keypad', style: { marginBlockEnd: 'var(--qs-spacing-md)' } },
      keys,
      h('button', { class: 'qs-btn', onClick: () => { state.amountMinor = 0; render(); } }, 'C'),
      h('button', { class: 'qs-btn', onClick: () => press(0) }, '0'),
      h('button', {
        class: 'qs-btn',
        onClick: () => {
          state.amountMinor = Math.floor(state.amountMinor / 10);
          render();
        },
      }, '⌫')),

    h('div', { class: 'qs-row', style: { marginBlockEnd: 'var(--qs-spacing-md)' } },
      h('button', {
        class: 'qs-btn',
        onClick: () => { state.amountMinor = bill.outstandingMinor; render(); },
      }, `${t('cashier.outstanding')}: ${formatMoney(bill.outstandingMinor, order.currency)}`),
      // Common round-number tenders, the shortcut every till has.
      [5, 10, 20, 50].map((note) =>
        h('button', {
          class: 'qs-btn',
          onClick: () => { state.amountMinor = note * 10 ** decimals; render(); },
        }, String(note)))),

    h('div', { class: 'till-methods' },
      Object.values(PaymentMethod).map((method) =>
        h('button', {
          class: method === PaymentMethod.CASH ? 'qs-btn qs-btn-primary' : 'qs-btn',
          disabled: state.amountMinor <= 0,
          onClick: () => void capture(order, bill, method),
        }, te('payments.method', method)))));
}

async function capture(order, bill, method) {
  const amountMinor = Math.min(state.amountMinor, bill.outstandingMinor);
  if (amountMinor <= 0) return;

  const body = { method, amountMinor };
  // Cash needs the tendered amount so the till can show the change to give.
  if (method === PaymentMethod.CASH && state.amountMinor >= amountMinor) {
    body.tenderedMinor = state.amountMinor;
  }

  const result = await guard(() => api.post(`/api/orders/${order.id}/payments`, body));
  if (!result) {
    sound.playFor(SoundEvent.PAYMENT_FAILED);
    return;
  }

  sound.playFor(SoundEvent.PAYMENT_SUCCESS);
  const change = result.payment.changeMinor;
  toast(
    change && change > 0
      ? `${t('cashier.change')}: ${formatMoney(change, order.currency)}`
      : te('payments.status', 'CAPTURED'),
    'success',
  );

  state.amountMinor = 0;
  await reload();
}

function paymentHistory(bill) {
  if (bill.payments.length === 0) return null;

  return h('div', { class: 'qs-card', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
    h('h3', {}, t('payments.title')),
    h('div', { class: 'qs-table-wrap' },
      h('table', { class: 'qs-table' },
        h('tbody', {}, bill.payments.map((payment) =>
          h('tr', {},
            h('td', {}, te('payments.method', payment.method)),
            h('td', {}, formatMoney(payment.amountMinor, selected().order.currency)),
            // Who took it — the accountability the spec insists on.
            h('td', { class: 'qs-muted' }, payment.capturedBy?.userName ?? '—'),
            h('td', { class: 'qs-muted qs-small' },
              payment.capturedAt ? formatTime(payment.capturedAt) : ''),
            h('td', {},
              h('span', {
                class: `qs-badge ${payment.status === 'REFUNDED' ? 'qs-badge-warning' : 'qs-badge-success'}`,
              }, te('payments.status', payment.status))),
            h('td', {},
              payment.status === 'CAPTURED'
                && grants(state.session.permissions, Permission.PAYMENTS_REFUND)
                ? h('button', {
                    class: 'qs-btn qs-btn-ghost qs-small',
                    onClick: () => void refund(payment),
                  }, t('cashier.refund'))
                : null)))))));
}

async function refund(payment) {
  const reason = window.prompt(t('cashier.refund_reason'));
  if (!reason) return;
  const result = await guard(() => api.post(`/api/payments/${payment.id}/refund`, { reason }));
  if (result) await reload();
}

function orderActions(order, bill) {
  const buttons = [];

  if (grants(state.session.permissions, Permission.PRINTING_USE)) {
    buttons.push(h('button', {
      class: 'qs-btn',
      onClick: () => void guard(() => api.post(`/api/orders/${order.id}/print-receipt`))
        .then((result) => result && toast(t('cashier.print_receipt'), 'success')),
    }, t('cashier.print_receipt')));
  }

  if (order.status === OrderStatus.PAID && bill.outstandingMinor === 0) {
    buttons.push(h('button', {
      class: 'qs-btn qs-btn-primary',
      onClick: async () => {
        const ok = await confirmDialog({
          title: t('cashier.close_order'),
          message: t('orders.order_number', { number: order.number }),
          confirmLabel: t('cashier.close_order'),
          cancelLabel: t('common.cancel'),
          danger: false,
        });
        if (!ok) return;
        const done = await guard(() =>
          api.post(`/api/orders/${order.id}/status`, { status: OrderStatus.CLOSED }));
        if (done) await reload();
      },
    }, t('cashier.close_order')));
  }

  return buttons.length > 0
    ? h('div', { class: 'qs-row', style: { marginBlockStart: 'var(--qs-spacing-lg)' } }, buttons)
    : null;
}

function render() {
  mount(root,
    offlineBanner(realtime),
    notifications.banner(),
    h('div', {
      class: 'till',
      // Ignored on a wide screen, where both panes are on show anyway.
      'data-pane': state.selectedId ? 'bill' : 'list',
    }, header(), orderList(), detail()));
}

/* ------------------------------------------------------------------ boot */

async function main() {
  const started = await boot({
    topics: ['cashier', 'orders', 'tables', 'system'],
    requireTerminal: true,
    onResync: () => void reload(),
  });
  state.session = started.session;
  realtime = started.realtime;
  notifications = started.notifications;
  notifications.onChange(() => {
    document.querySelector('.qs-notify-banner')?.replaceWith(notifications.banner());
  });

  await reload();

  realtime.on('order.created', () => {
    sound.playFor(SoundEvent.NEW_ORDER);
    void reload();
  });
  realtime.on('order.status_changed', ({ order }) => {
    if (order.status === OrderStatus.CANCELLED) sound.playFor(SoundEvent.ORDER_CANCELLED);
    void reload();
  });
  realtime.on('order.items_changed', () => void reload());
  realtime.on('payment.captured', () => void reload());
  realtime.on('payment.refunded', () => void reload());
}

void main().catch((error) => console.error('[cashier]', error));
