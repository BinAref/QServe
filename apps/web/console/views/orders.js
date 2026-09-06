/**
 * Orders, reports and the audit log.
 *
 * The order detail view is the spec's §19 timeline made real: every event, who
 * caused it, from which station, and when. It is the screen a manager opens
 * when a diner disputes a bill, so it shows the raw record rather than a
 * summary.
 */

import { api, guard, t } from '../../shared/boot.js';
import { h, mount, modal } from '../../shared/dom.js';
import { formatMoney, pick, te, formatDateTime, formatTime } from '../../shared/i18n.js';
import { Capability, Permission } from '../../shared/events.js';
import { state, has, can, pageHeader, lockedPanel } from '../app.js';

/* --------------------------------------------------------------- orders */

export async function renderOrders(container) {
  if (!can(Capability.ORDERS_RUNTIME)) {
    mount(container, pageHeader(t('orders.title')), lockedPanel(Capability.ORDERS_RUNTIME));
    return;
  }

  const openOnly = state.ordersOpenOnly ?? true;
  const { orders } = await api.get(`/api/orders?limit=200${openOnly ? '&open=true' : ''}`);

  mount(container,
    pageHeader(t('orders.title'),
      h('button', {
        class: 'qs-btn',
        onClick: () => {
          state.ordersOpenOnly = !openOnly;
          void renderOrders(container);
        },
      }, openOnly ? t('common.all') : t('tables.open_orders'))),

    orders.length === 0
      ? h('div', { class: 'qs-card' }, h('div', { class: 'qs-empty' }, t('orders.no_orders')))
      : h('div', { class: 'qs-card' },
          h('div', { class: 'qs-table-wrap' },
            h('table', { class: 'qs-table qs-table-clickable' },
              h('thead', {}, h('tr', {},
                h('th', {}, '#'),
                h('th', {}, t('orders.table')),
                h('th', {}, t('common.status')),
                h('th', {}, t('orders.source')),
                h('th', {}, t('orders.created_by')),
                h('th', {}, t('common.total')),
                h('th', {}, t('common.created')))),
              h('tbody', {}, orders.map((order) =>
                h('tr', { onClick: () => void openOrder(order.id) },
                  h('td', { class: 'qs-strong' }, String(order.number)),
                  h('td', {}, order.tableLabel ?? '—'),
                  h('td', {}, h('span', { class: 'qs-badge' }, te('orders.status', order.status))),
                  h('td', {}, te('orders.source', order.source)),
                  h('td', { class: 'qs-muted' },
                    order.createdBy.userName ?? order.createdBy.terminalName ?? '—'),
                  h('td', {}, formatMoney(order.totals.totalMinor, order.currency)),
                  h('td', { class: 'qs-muted qs-small' }, formatDateTime(order.createdAt)))))))));
}

async function openOrder(orderId) {
  const detail = await guard(() => api.get(`/api/orders/${orderId}`));
  if (!detail) return;

  const { order, bill, availableTransitions } = detail;
  const timeline = await api.get(`/api/orders/${orderId}/timeline`).catch(() => ({ events: [] }));

  modal({
    title: t('orders.order_number', { number: order.number }),
    body: h('div', {},
      h('div', { class: 'qs-row qs-row-between' },
        h('span', { class: 'qs-badge' }, te('orders.status', order.status)),
        h('span', {}, `${t('orders.table')} ${order.tableLabel ?? '—'}`)),

      // The four accountability facts the spec asks to be persisted, not just
      // displayed: source, who created, who served, who took payment.
      h('div', { class: 'qs-card qs-card-tight', style: { marginBlock: 'var(--qs-spacing-md)' } },
        h('div', {}, `${t('orders.source')}: `, h('strong', {}, te('orders.source', order.source))),
        h('div', {}, `${t('orders.created_by')}: `,
          h('strong', {}, order.createdBy.userName ?? order.createdBy.kind),
          order.createdBy.terminalName ? h('span', { class: 'qs-muted' }, ` · ${order.createdBy.terminalName}`) : null),
        order.servedBy?.userName
          ? h('div', {}, `${t('orders.served_by')}: `, h('strong', {}, order.servedBy.userName))
          : null,
        order.paidBy?.userName
          ? h('div', {}, `${t('orders.paid_by')}: `, h('strong', {}, order.paidBy.userName),
              order.paidBy.terminalName ? h('span', { class: 'qs-muted' }, ` · ${order.paidBy.terminalName}`) : null)
          : null),

      h('div', { class: 'qs-section-title' }, t('menu.products')),
      order.items.map((item) =>
        h('div', { class: 'qs-row qs-row-between', style: { paddingBlock: '4px' } },
          h('div', {},
            h('span', {}, `${item.quantity}× ${pick(item.name)}`),
            item.selections.map((selection) =>
              h('div', { class: 'qs-xs qs-muted' }, `· ${pick(selection.name)}`)),
            item.addons.map((addon) =>
              h('div', { class: 'qs-xs qs-muted' }, `+ ${addon.quantity} ${pick(addon.name)}`)),
            item.notes ? h('div', { class: 'qs-xs qs-muted' }, `“${item.notes}”`) : null),
          h('span', {}, formatMoney(item.lineTotalMinor, order.currency)))),

      h('div', { class: 'qs-row qs-row-between', style: { marginBlockStart: 'var(--qs-spacing-sm)' } },
        h('strong', {}, t('common.total')),
        h('strong', {}, formatMoney(order.totals.totalMinor, order.currency))),
      bill.outstandingMinor > 0
        ? h('div', { class: 'qs-row qs-row-between' },
            h('span', {}, t('cashier.outstanding')),
            h('span', {}, formatMoney(bill.outstandingMinor, order.currency)))
        : null,

      availableTransitions.length > 0
        ? h('div', {},
            h('div', { class: 'qs-section-title' }, t('common.actions')),
            h('div', { class: 'qs-row' }, availableTransitions.map((transition) =>
              h('button', {
                class: transition.destructive ? 'qs-btn qs-btn-danger' : 'qs-btn',
                onClick: async () => {
                  const done = await guard(() =>
                    api.post(`/api/orders/${order.id}/status`, { status: transition.to }));
                  if (done) {
                    document.querySelector('dialog[open]')?.close();
                    await renderOrders(document.querySelector('.qs-page'));
                  }
                },
              }, t(transition.labelKey)))))
        : null,

      h('div', { class: 'qs-section-title' }, t('orders.timeline')),
      h('div', { class: 'qs-table-wrap' },
        h('table', { class: 'qs-table' },
          h('tbody', {}, timeline.events.map((event) =>
            h('tr', {},
              h('td', { class: 'qs-mono qs-xs' }, formatTime(event.at)),
              h('td', {}, event.action),
              h('td', { class: 'qs-muted' },
                event.actor.userName ?? event.actor.terminalName ?? event.actor.kind),
              h('td', { class: 'qs-xs qs-muted' },
                event.after ? JSON.stringify(event.after) : ''))))))),
    actions: [h('button', { class: 'qs-btn qs-btn-primary', value: 'close' }, t('common.close'))],
  });
}

/* -------------------------------------------------------------- reports */

export async function renderReports(container) {
  if (!can(Capability.REPORTS_RUNTIME)) {
    mount(container, pageHeader(t('reports.title')), lockedPanel(Capability.REPORTS_RUNTIME));
    return;
  }

  const since = state.reportSince ?? '';
  const until = state.reportUntil ?? '';
  const query = new URLSearchParams();
  if (since) query.set('since', `${since}T00:00:00.000Z`);
  if (until) query.set('until', `${until}T23:59:59.999Z`);

  const report = await api.get(`/api/reports/sales?${query}`);
  const money = (minor) => formatMoney(minor, report.currency);

  const stat = (value, label) =>
    h('div', { class: 'stat' },
      h('div', { class: 'stat-value' }, value),
      h('div', { class: 'stat-label' }, label));

  mount(container,
    pageHeader(t('reports.sales'),
      h('a', {
        class: 'qs-btn',
        href: `/api/reports/sales?${query}&format=csv`,
        download: '',
      }, t('reports.export_csv'))),

    h('div', { class: 'qs-card', style: { marginBlockEnd: 'var(--qs-spacing-lg)' } },
      h('div', { class: 'qs-row' },
        h('label', { class: 'qs-field', style: { marginBlockEnd: 0 } },
          h('span', {}, t('reports.range')),
          h('input', {
            type: 'date', value: since,
            onChange: (event) => { state.reportSince = event.target.value; void renderReports(container); },
          })),
        h('label', { class: 'qs-field', style: { marginBlockEnd: 0 } },
          h('span', {}, '—'),
          h('input', {
            type: 'date', value: until,
            onChange: (event) => { state.reportUntil = event.target.value; void renderReports(container); },
          })),
        h('button', {
          class: 'qs-btn',
          onClick: () => {
            state.reportSince = undefined;
            state.reportUntil = undefined;
            void renderReports(container);
          },
        }, t('reports.today')))),

    h('div', { class: 'stat-grid' },
      stat(String(report.totals.orders), t('reports.orders_count')),
      stat(money(report.totals.grossMinor), t('reports.gross')),
      stat(money(report.totals.netMinor), t('reports.net')),
      stat(money(report.totals.averageOrderMinor), t('reports.average_order'))),

    h('div', { class: 'qs-grid qs-grid-2', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
      breakdown(t('reports.by_source'), report.bySource.map((row) =>
        [te('orders.source', row.source), `${row.orders}`, money(row.grossMinor)])),
      breakdown(t('reports.by_method'), report.byPaymentMethod.map((row) =>
        [te('payments.method', row.method), `${row.count}`, money(row.totalMinor)])),
      breakdown(t('reports.by_cashier'), report.byCashier.map((row) =>
        [row.userName ?? '—', `${row.count}`, money(row.totalMinor)])),
      breakdown(t('reports.top_products'), report.topProducts.map((row) =>
        [pick(row.name), `${row.quantity}`, money(row.grossMinor)]))));
}

function breakdown(title, rows) {
  return h('div', { class: 'qs-card' },
    h('h3', {}, title),
    rows.length === 0
      ? h('p', { class: 'qs-muted qs-small' }, t('common.empty'))
      : h('table', { class: 'qs-table' },
          h('tbody', {}, rows.map((row) =>
            h('tr', {},
              h('td', {}, row[0]),
              h('td', { class: 'qs-muted' }, row[1]),
              h('td', { style: { textAlign: 'end' } }, row[2]))))));
}

/* ---------------------------------------------------------------- audit */

export async function renderAudit(container) {
  const { entries } = await api.get('/api/audit?limit=300');

  mount(container,
    pageHeader(t('audit.title')),
    h('p', { class: 'qs-muted' }, t('orders.timeline')),

    h('div', { class: 'qs-card' },
      h('div', { class: 'qs-table-wrap' },
        h('table', { class: 'qs-table' },
          h('thead', {}, h('tr', {},
            h('th', {}, t('audit.when')),
            h('th', {}, t('audit.action')),
            h('th', {}, t('audit.who')),
            h('th', {}, t('audit.entity')),
            h('th', {}, t('audit.detail')))),
          h('tbody', {}, entries.map((entry) =>
            h('tr', {},
              h('td', { class: 'qs-xs qs-muted qs-nowrap' }, formatDateTime(entry.at)),
              h('td', { class: 'qs-small' }, entry.action),
              h('td', { class: 'qs-small' },
                entry.actor.userName ?? entry.actor.terminalName ?? entry.actor.kind),
              h('td', { class: 'qs-mono qs-xs' }, `${entry.entityType} ${entry.entityId ?? ''}`),
              h('td', { class: 'qs-xs qs-muted' },
                JSON.stringify(entry.after ?? entry.detail ?? {}).slice(0, 120)))))))));
}
