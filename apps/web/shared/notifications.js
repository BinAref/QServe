/**
 * The notification centre every terminal carries.
 *
 * A restaurant already runs on shouted sentences — "table nine is ready",
 * "table four wants the bill". On a busy Friday the shout does not carry and
 * the ticket goes cold. This is the same sentence, addressed rather than
 * shouted, and kept until somebody says they heard it.
 *
 * Three behaviours are the whole point:
 *
 *  - **It arrives without being asked for.** The socket delivers it; the list
 *    is only re-fetched on connect, for a station that was rebooting.
 *  - **Urgent keeps asking.** The sound repeats until acknowledged, because a
 *    cook who walked to the walk-in has not heard anything yet.
 *  - **Acknowledging clears it everywhere.** Two waiters do not both walk over.
 */

import { api } from './api.js';
import { h, mount } from './dom.js';
import { t, formatTime } from './i18n.js';
import { sound } from './sound.js';
import { NOTIFICATION_SOUND, NotificationUrgency } from './events.js';

export class NotificationCentre {
  #items = [];
  #listeners = new Set();
  #open = false;

  /**
   * @param realtime  the socket to listen on
   * @param onArrive  optional: a terminal that wants to react itself
   */
  constructor(realtime, { onArrive = null } = {}) {
    this.realtime = realtime;
    this.onArrive = onArrive;

    // The handler is called with the payload first, the envelope second.
    realtime.on('notification', (notification) => this.#receive(notification));
    // A station that was off, or asleep in someone's apron, catches up here.
    realtime.onStateChange((state) => {
      if (state === 'open') void this.refresh();
    });
  }

  get items() { return this.#items; }
  get open() { return this.#items.filter((item) => !item.acknowledgedAt); }
  get urgent() {
    return this.open.filter((item) => item.urgency === NotificationUrgency.URGENT);
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Catch up on what is open.
   *
   * Merged rather than assigned: this fetch and the socket race on connect, and
   * replacing the list wholesale would drop a notice that arrived while the
   * request was in flight. In a restaurant that is a call that vanishes.
   */
  async refresh() {
    let fetched;
    try {
      ({ notifications: fetched } = await api.get('/api/notifications?limit=50'));
    } catch {
      // A station with no connection has nothing to show and says so elsewhere.
      return;
    }

    const byId = new Map(fetched.map((item) => [item.id, item]));
    for (const item of this.#items) {
      const server = byId.get(item.id);
      // The server's copy wins on anything it knows about; a locally
      // acknowledged one that the server has not confirmed yet stays that way.
      if (!server) {
        if (!item.acknowledgedAt) byId.set(item.id, item);
      } else if (item.acknowledgedAt && !server.acknowledgedAt) {
        byId.set(item.id, { ...server, acknowledgedAt: item.acknowledgedAt });
      }
    }

    this.#items = [...byId.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.#announce();
  }

  #receive(notification) {
    if (!notification?.id) return;

    const index = this.#items.findIndex((item) => item.id === notification.id);
    const isNew = index === -1;
    if (isNew) this.#items.unshift(notification);
    else this.#items[index] = notification;

    // An acknowledgement arriving from another station silences this one too.
    if (notification.acknowledgedAt) {
      const soundEvent = NOTIFICATION_SOUND[notification.kind];
      if (soundEvent) sound.stop(soundEvent);
    } else if (isNew) {
      const soundEvent = NOTIFICATION_SOUND[notification.kind];
      if (soundEvent) sound.playFor(soundEvent);
      this.onArrive?.(notification);
    }

    this.#announce();
  }

  async acknowledge(id) {
    const item = this.#items.find((entry) => entry.id === id);
    const soundEvent = item ? NOTIFICATION_SOUND[item.kind] : null;
    if (soundEvent) sound.stop(soundEvent);

    // Optimistic: the socket will confirm, and a waiter who tapped should not
    // watch a spinner while holding three plates.
    if (item) item.acknowledgedAt = new Date().toISOString();
    this.#announce();

    try {
      await api.post(`/api/notifications/${id}/ack`);
    } catch {
      if (item) item.acknowledgedAt = null;
      this.#announce();
    }
  }

  async acknowledgeAll() {
    sound.stopAll();
    for (const item of this.open) item.acknowledgedAt = new Date().toISOString();
    this.#announce();
    await api.post('/api/notifications/ack-all').catch(() => this.refresh());
  }

  /** Raise one by hand — the "call a waiter" button, and the manager's message. */
  async raise(kind, extra = {}) {
    return api.post('/api/notifications', { kind, ...extra });
  }

  #announce() {
    for (const listener of this.#listeners) listener(this);
  }

  /* ------------------------------------------------------------------ ui */

  /**
   * The bell for a header. Shows how many are waiting, opens the list, and
   * pulses while something urgent is unanswered — the pulse is the difference
   * between a badge somebody notices and one they scroll past.
   */
  bell() {
    const count = h('span', { class: 'qs-bell-count' });
    const button = h('button', {
      class: 'qs-bell',
      'aria-label': t('notify.title'),
      onClick: () => this.togglePanel(),
    }, h('span', { class: 'qs-bell-mark' }, '🔔'), count);

    const paint = () => {
      const waiting = this.open.length;
      count.textContent = waiting > 99 ? '99+' : String(waiting);
      button.dataset.count = String(waiting);
      button.dataset.urgent = String(this.urgent.length > 0);
    };
    this.onChange(paint);
    paint();
    return button;
  }

  togglePanel() {
    this.#open = !this.#open;
    if (this.#open) this.#showPanel();
    else document.getElementById('qs-notify-panel')?.remove();
  }

  #showPanel() {
    document.getElementById('qs-notify-panel')?.remove();

    const list = h('div', { class: 'qs-notify-list' });
    const panel = h('div', { class: 'qs-notify-panel', id: 'qs-notify-panel' },
      h('div', { class: 'qs-notify-head' },
        h('strong', {}, t('notify.title')),
        h('div', { class: 'qs-row' },
          h('button', {
            class: 'qs-btn qs-btn-ghost qs-btn-sm',
            onClick: () => void this.acknowledgeAll(),
          }, t('notify.clear_all')),
          h('button', {
            class: 'qs-icon-btn',
            'aria-label': t('common.close'),
            onClick: () => this.togglePanel(),
          }, '×'))),
      list);

    const paint = () => {
      const waiting = this.open;
      mount(list, waiting.length === 0
        ? h('div', { class: 'qs-empty qs-small' }, t('notify.empty'))
        : h('div', { class: 'qs-stagger' }, waiting.map((item) => this.#row(item))));
    };
    const stop = this.onChange(paint);
    paint();

    panel.addEventListener('qs-close', stop);
    document.body.append(panel);
  }

  #row(item) {
    return h('article', {
      class: 'qs-notify-item',
      'data-urgency': item.urgency,
      'data-kind': item.kind,
    },
      h('div', { class: 'qs-notify-body' },
        h('strong', {}, t(item.messageKey, item.params)),
        item.body ? h('p', { class: 'qs-small' }, item.body) : null,
        h('div', { class: 'qs-xs qs-muted' },
          formatTime(item.createdAt),
          item.from.terminalName ? ` · ${item.from.terminalName}` : '',
          item.from.userName ? ` · ${item.from.userName}` : '')),
      h('button', {
        class: 'qs-btn qs-btn-sm',
        onClick: () => void this.acknowledge(item.id),
      }, t('notify.acknowledge')));
  }

  /**
   * A banner for the most urgent unanswered notice, for screens where a bell in
   * a corner is not enough — a kitchen pass is looked at from two metres away.
   */
  banner() {
    const node = h('div', { class: 'qs-notify-banner qs-hidden' });

    const paint = () => {
      const [first] = this.urgent;
      node.classList.toggle('qs-hidden', !first);
      if (!first) return;

      mount(node,
        h('span', { class: 'qs-grow' }, t(first.messageKey, first.params)),
        this.urgent.length > 1
          ? h('span', { class: 'qs-badge' }, `+${this.urgent.length - 1}`)
          : null,
        h('button', {
          class: 'qs-btn qs-btn-sm',
          onClick: () => void this.acknowledge(first.id),
        }, t('notify.acknowledge')));
    };
    this.onChange(paint);
    paint();
    return node;
  }
}
