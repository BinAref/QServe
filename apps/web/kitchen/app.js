/**
 * Kitchen Display System (spec §16, §17, §44).
 *
 * Design constraints that come from the room, not from software:
 *
 *  - A cook is two metres away with their hands full, so type is large, colour
 *    carries meaning, and every action is a single big button.
 *  - A new order must be *heard*, not just shown, and the alert repeats until
 *    someone acknowledges it — a screen nobody looked at is how food is lost.
 *  - The board must never silently go stale. If the socket drops, a banner says
 *    so, and on reconnect the whole board is reloaded rather than patched.
 */

import { boot, connectionIndicator, offlineBanner, guard, api, sound, t, roleLabel } from '../shared/boot.js';
import { h, mount, toast } from '../shared/dom.js';
import { pick, te, formatTime } from '../shared/i18n.js';
import { SoundEvent, OrderStatus, grants, Permission } from '../shared/events.js';

const state = {
  session: null,
  queue: [],
  settings: { groupByStation: true, showSourceBadge: true, urgentAfterMinutes: 15 },
  /** Station filter chosen on this screen; null means everything. */
  station: null,
  /** Order ids whose alert this screen has already sounded. */
  alerted: new Set(),
};

const root = document.getElementById('app');
let realtime;
let notifications;

/* ----------------------------------------------------------------- data */

async function reload() {
  const result = await api.get('/api/kitchen/queue').catch(() => null);
  if (!result) return;
  state.queue = result.queue;
  state.settings = result.settings;
  render();
}

const stations = () => {
  const found = new Set();
  for (const entry of state.queue) {
    for (const item of entry.order.items) if (item.station) found.add(item.station);
  }
  return [...found].sort();
};

function visibleQueue() {
  if (!state.station) return state.queue;
  return state.queue
    .map((entry) => ({
      ...entry,
      order: {
        ...entry.order,
        items: entry.order.items.filter((item) => item.station === state.station),
      },
    }))
    .filter((entry) => entry.order.items.length > 0);
}

/* ---------------------------------------------------------------- views */

function header() {
  const list = stations();

  return h('header', { class: 'kds-head' },
    // Whatever this restaurant calls the people who work here.
    h('h1', {}, roleLabel('KITCHEN')),
    state.session.terminal
      ? h('span', { class: 'qs-badge' }, pick(state.session.terminal.name))
      : null,

    list.length > 0
      ? h('div', { class: 'kds-filters' },
          h('button', {
            class: 'kds-filter',
            'aria-pressed': String(state.station === null),
            onClick: () => { state.station = null; render(); },
          }, t('kitchen.all_stations')),
          list.map((station) =>
            h('button', {
              class: 'kds-filter',
              'aria-pressed': String(state.station === station),
              onClick: () => { state.station = station; render(); },
            }, station)))
      : null,

    h('span', { class: 'qs-grow' }),

    // Silences a repeating alert without touching an order — the "I heard it"
    // button a cook reaches for first.
    sound.isAlerting
      ? h('button', {
          class: 'qs-btn qs-btn-primary',
          onClick: () => { sound.stopAll(); render(); },
        }, t('kitchen.acknowledge'))
      : null,

    notifications.bell(),
    connectionIndicator(realtime));
}

/** "Waiter — Ahmed", "Customer": who sent it, in the console's own words. */
function sourceLine(order) {
  const who = order.createdBy.userName ?? order.createdBy.terminalName ?? null;
  const source = te('orders.source', order.source);
  return who && who !== order.tableLabel ? `${source} — ${who}` : source;
}

/**
 * How long a ticket has been waiting, in the largest unit that still says
 * something. "863 min ago" is a number nobody converts at a hot pass.
 */
function age(ageSeconds) {
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return t('orders.age_minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? t('orders.age_hours', { hours, minutes: minutes % 60 })
    : t('orders.age_days', { days: Math.floor(hours / 24) });
}

function ticket(entry) {
  const { order, ageSeconds, urgent } = entry;

  // The one ticket on the board that is waiting on somebody carries the
  // travelling light. Anything else lit at the same time would dilute it.
  const late = urgent && order.status !== OrderStatus.READY;

  return h('article', {
    class: `kds-ticket${late ? ' qs-lit qs-lit-urgent' : ''}`,
    'data-status': order.status,
    'data-urgent': String(late),
  },
    h('div', { class: 'kds-ticket-head' },
      h('span', { class: 'kds-number' }, `#${order.number}`),
      h('span', { class: 'kds-table' }, order.tableLabel ?? '—'),
      h('span', {
        class: 'kds-age',
        'data-urgent': String(urgent),
        title: formatTime(order.createdAt),
      }, age(ageSeconds))),

    // Where the ticket came from, in the word the rest of the product uses —
    // and the person only when they are somebody other than the table already
    // printed above, which is the difference between a fact and a repetition.
    state.settings.showSourceBadge
      ? h('div', { class: 'kds-source' }, sourceLine(order))
      : null,

    h('div', { class: 'kds-items' }, order.items.map((item) =>
      h('div', { class: 'kds-item' },
        h('div', { class: 'kds-item-main' },
          h('span', { class: 'kds-item-qty' }, `${item.quantity}×`),
          h('span', {}, pick(item.name),
            !state.station && item.station
              ? h('span', { class: 'kds-station-tag' }, item.station)
              : null)),
        item.selections.map((selection) =>
          h('div', { class: 'kds-item-sub' }, `· ${pick(selection.name)}`)),
        item.addons.map((addon) =>
          h('div', { class: 'kds-item-sub' }, `+ ${addon.quantity} ${pick(addon.name)}`)),
        item.notes ? h('div', { class: 'kds-item-note' }, `! ${item.notes}`) : null))),

    order.notes ? h('div', { class: 'kds-order-note' }, order.notes) : null,

    h('div', { class: 'kds-actions' }, actionsFor(order)));
}

/**
 * Only the transitions this station may actually perform, in the order the
 * spec's state machine allows. The server enforces the same rules; showing a
 * button that would be refused just wastes a cook's tap.
 */
function actionsFor(order) {
  const may = grants(state.session.permissions, Permission.ORDERS_CHANGE_STATUS);
  if (!may) return h('span', { class: 'qs-muted qs-small' }, t('error.forbidden'));

  const button = (status, label, variant = '') =>
    h('button', {
      class: `qs-btn ${variant}`,
      onClick: () => void advance(order, status),
    }, label);

  switch (order.status) {
    case OrderStatus.NEW:
      return [
        button(OrderStatus.ACCEPTED, t('orders.action.accept'), 'qs-btn-primary'),
        button(OrderStatus.REJECTED, t('orders.action.reject'), 'qs-btn-danger'),
      ];
    case OrderStatus.ACCEPTED:
      return [
        button(OrderStatus.PREPARING, t('orders.action.start_preparing'), 'qs-btn-primary'),
        button(OrderStatus.ON_HOLD, t('orders.action.hold')),
      ];
    case OrderStatus.PREPARING:
      return [
        button(OrderStatus.READY, t('orders.action.mark_ready'), 'qs-btn-primary'),
        button(OrderStatus.ON_HOLD, t('orders.action.hold')),
      ];
    case OrderStatus.READY:
      return h('span', { class: 'qs-badge qs-badge-success' }, te('orders.status', order.status));
    case OrderStatus.ON_HOLD:
      return button(OrderStatus.PREPARING, t('orders.action.resume'), 'qs-btn-primary');
    default:
      return h('span', { class: 'qs-badge' }, te('orders.status', order.status));
  }
}

async function advance(order, status) {
  // Acknowledging by acting is the natural gesture: touching an order silences
  // the alarm for it.
  sound.stopAll();

  const updated = await guard(() => api.post(`/api/orders/${order.id}/status`, { status }));
  if (!updated) {
    // A refusal usually means another station got there first; resync rather
    // than leave this screen showing a state the server rejected.
    await reload();
    return;
  }
  if (status === OrderStatus.READY) sound.playFor(SoundEvent.ORDER_READY);
  await reload();
}

function render() {
  const queue = visibleQueue();

  mount(root,
    offlineBanner(realtime),
    notifications.banner(),
    h('div', { class: 'kds', 'data-sound': sound.unlocked ? 'on' : 'locked' },
      header(),
      queue.length === 0
        ? h('div', { class: 'qs-empty' }, t('kitchen.no_orders'))
        : h('div', { class: 'kds-board' }, queue.map(ticket)),
      // A browser will not make a sound until somebody has touched the page,
      // so a kitchen screen left alone on a wall is silent until asked. The
      // prompt says what tapping does — "Sound enabled" read like a status,
      // which is the one thing it was not.
      !sound.unlocked
        ? h('div', { class: 'kds-sound-prompt' },
            h('button', {
              class: 'qs-btn qs-btn-primary',
              onClick: () => { sound.unlock(); render(); },
            }, `🔔 ${t('sound.turn_on')}`))
        : null));
}

/* ------------------------------------------------------------------ boot */

async function main() {
  const started = await boot({
    topics: ['kitchen', 'orders', 'menu', 'system'],
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

  realtime.on('order.created', (order, event) => {
    if (!state.alerted.has(order.id)) {
      state.alerted.add(order.id);
      sound.playFor(SoundEvent.NEW_ORDER);
      toast(t('kitchen.new_order_alert', { table: order.tableLabel ?? '—' }), 'info');
      realtime.acknowledge(event.seq);
    }
    void reload();
  });

  realtime.on('order.items_changed', () => void reload());

  realtime.on('order.status_changed', ({ order }) => {
    if (order.status === OrderStatus.CANCELLED) {
      sound.playFor(SoundEvent.ORDER_CANCELLED);
      toast(`${t('orders.order_number', { number: order.number })} · ${te('orders.status', order.status)}`, 'warning');
    }
    void reload();
  });

  // Ticket ages are the kitchen's sense of urgency, so they tick even when
  // nothing else happens.
  setInterval(() => {
    for (const entry of state.queue) {
      entry.ageSeconds = Math.floor((Date.now() - new Date(entry.order.createdAt).getTime()) / 1000);
      entry.urgent = entry.ageSeconds > state.settings.urgentAfterMinutes * 60;
    }
    render();
  }, 20_000);
}

void main().catch((error) => console.error('[kitchen]', error));
