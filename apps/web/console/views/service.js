/**
 * Tables and terminals (spec §9, §11, §14, §16, §24).
 *
 * Both are the same thing underneath — a terminal with a QR — so both screens
 * share the QR sheet, which is designed to be printed: a page of cards, each
 * with its code and a human-readable station code beneath it.
 *
 * Everything here is licence-gated. In SETUP the screen still renders, showing
 * what activation unlocks rather than an empty page.
 */

import { api, guard, t, toast, stationLabel } from '../../shared/boot.js';
import { h, mount, modal, confirmDialog } from '../../shared/dom.js';
import { pick, te, formatDateTime } from '../../shared/i18n.js';
import { localisedField, mergeLocalised, languageNote } from '../../shared/fields.js';
import { Capability, Permission, TerminalType } from '../../shared/events.js';
import { state, has, can, pageHeader, lockedPanel, enabledLocales } from '../app.js';

/**
 * A station's type, in this restaurant's words. An owner who renamed their
 * waiters sees that name here too — the terminal list is where they go looking
 * for it, and one product using two words for one thing is a bug.
 */
const typeLabel = (type) => stationLabel(type, te('terminals.type', type));

/* ------------------------------------------------------------- QR sheet */

/**
 * The printable card. `svg` comes from the server already rendered, so the
 * console does not carry a QR library and the printed code is identical to the
 * one the server would encode.
 */
function qrCard({ svg, url, publicCode, title, subtitle }) {
  const holder = h('div', { class: 'qs-card qr-card' },
    h('h3', {}, title),
    subtitle ? h('p', { class: 'qs-muted qs-small' }, subtitle) : null,
    h('div', { class: 'qr-svg' }),
    h('p', { class: 'qr-code-text' }, publicCode ?? ''),
    h('p', { class: 'qs-muted qr-url' }, url ?? ''));

  // The SVG is trusted server output, not user input, and inserting it as
  // markup is what keeps the printed code crisp at any paper size.
  holder.querySelector('.qr-svg').innerHTML = svg ?? '';
  return holder;
}

async function openQr(path, title, subtitle) {
  const qr = await guard(() => api.get(path));
  if (!qr) return;

  modal({
    title: t('tables.qr'),
    body: h('div', {},
      qrCard({ ...qr, title, subtitle }),
      h('p', { class: 'qs-small qs-muted' }, t('terminals.scan_hint'))),
    actions: [
      h('button', {
        class: 'qs-btn', value: 'print', type: 'button',
        onClick: () => window.print(),
      }, t('common.print')),
      h('button', {
        class: 'qs-btn', value: 'download', type: 'button',
        onClick: () => {
          // Downloading the SVG lets a restaurant put it on a designed card.
          const blob = new Blob([qr.svg], { type: 'image/svg+xml' });
          const link = h('a', { href: URL.createObjectURL(blob), download: `${title}.svg` });
          link.click();
          URL.revokeObjectURL(link.href);
        },
      }, t('tables.download_qr')),
      h('button', { class: 'qs-btn qs-btn-primary', value: 'close' }, t('common.close')),
    ],
  });
}

/* --------------------------------------------------------------- tables */

export async function renderTables(container) {
  if (!can(Capability.TABLES_PROVISION)) {
    mount(container, pageHeader(t('tables.title')), lockedPanel(Capability.TABLES_PROVISION));
    return;
  }

  const { tables } = await api.get('/api/tables');
  const canManage = has(Permission.TABLES_MANAGE);

  mount(container,
    pageHeader(t('tables.title'),
      canManage ? h('button', { class: 'qs-btn', onClick: () => openBulkForm(container) }, t('tables.add_range')) : null,
      canManage ? h('button', { class: 'qs-btn qs-btn-primary', onClick: () => openTableForm(container, null) }, t('tables.add')) : null),

    tables.length === 0
      ? h('div', { class: 'qs-card' }, h('div', { class: 'qs-empty' }, t('common.empty')))
      : h('div', { class: 'qs-grid qs-grid-cards qr-print-sheet' }, tables.map((table) =>
          h('div', { class: 'qs-card' },
            h('div', { class: 'qs-card-head' },
              h('h3', { style: { margin: 0 } }, table.label),
              h('span', { class: 'qs-badge' }, te('tables.status', table.status))),
            h('p', { class: 'qs-small qs-muted' },
              `${table.seats} ${t('common.seats')}`,
              table.zone ? ` · ${table.zone}` : '',
              table.activeOrderIds.length > 0
                ? ` · ${table.activeOrderIds.length} ${t('tables.open_orders')}`
                : ''),
            h('p', { class: 'qs-mono qs-xs' }, table.id),
            h('div', { class: 'qs-row no-print' },
              h('button', {
                class: 'qs-btn',
                onClick: () => void openQr(`/api/tables/${table.id}/qr`, table.label,
                  `${state.status.restaurantId} · ${table.id}`),
              }, t('tables.qr')),
              canManage
                ? h('button', { class: 'qs-btn qs-btn-ghost', onClick: () => openTableForm(container, table) },
                    t('common.edit'))
                : null)))));
}

function openTableForm(container, table) {
  const form = h('form', {},
    h('label', { class: 'qs-field' },
      h('span', {}, t('common.label')),
      h('input', { name: 'label', required: true, maxlength: '24', value: table?.label ?? '' })),
    h('div', { class: 'qs-grid qs-grid-2' },
      h('label', { class: 'qs-field' },
        h('span', {}, t('common.seats')),
        h('input', { name: 'seats', type: 'number', min: '1', max: '100', value: table?.seats ?? 4 })),
      h('label', { class: 'qs-field' },
        h('span', {}, t('common.zone')),
        h('input', { name: 'zone', maxlength: '60', value: table?.zone ?? '' }))),
    table
      ? h('p', { class: 'qs-xs qs-muted' }, `${t('license.restaurant_id')}: ${state.status.restaurantId} · ${table.id}`)
      : null);

  const dialog = modal({
    title: table ? table.label : t('tables.add'),
    body: form,
    actions: [
      table
        ? h('button', {
            class: 'qs-btn qs-btn-danger', value: 'delete',
            onClick: async (event) => {
              event.preventDefault();
              const ok = await confirmDialog({
                title: t('common.delete'),
                message: table.activeOrderIds.length > 0
                  ? t('tables.has_open_orders')
                  : table.label,
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
              });
              if (!ok) return;
              const done = await guard(() => api.del(`/api/tables/${table.id}`));
              if (!done) return;
              dialog.close();
              await renderTables(container);
            },
          }, t('common.delete'))
        : null,
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary', value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());
          const payload = {
            label: String(data.label).trim(),
            seats: Number(data.seats),
            zone: String(data.zone ?? '').trim() || null,
          };
          const saved = await guard(() => table
            ? api.patch(`/api/tables/${table.id}`, payload)
            : api.post('/api/tables', payload));
          if (!saved) return;
          dialog.close();
          await renderTables(container);
        },
      }, t('common.save')),
    ],
  });
}

function openBulkForm(container) {
  const form = h('form', {},
    h('div', { class: 'qs-grid qs-grid-3' },
      h('label', { class: 'qs-field' },
        h('span', {}, t('tables.prefix')),
        h('input', { name: 'prefix', value: 'Table ', maxlength: '12' })),
      h('label', { class: 'qs-field' },
        h('span', {}, t('tables.from')),
        h('input', { name: 'from', type: 'number', min: '1', max: '9999', value: '1', required: true })),
      h('label', { class: 'qs-field' },
        h('span', {}, t('tables.to')),
        h('input', { name: 'to', type: 'number', min: '1', max: '9999', value: '10', required: true }))),
    h('label', { class: 'qs-field' },
      h('span', {}, t('common.seats')),
      h('input', { name: 'seats', type: 'number', min: '1', max: '100', value: '4' })));

  const dialog = modal({
    title: t('tables.add_range'),
    body: form,
    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary', value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());
          const result = await guard(() => api.post('/api/tables/bulk', {
            prefix: data.prefix,
            from: Number(data.from),
            to: Number(data.to),
            seats: Number(data.seats),
          }));
          if (!result) return;
          dialog.close();
          toast(`${result.created.length} ${t('nav.tables')}`, 'success');
          if (result.skipped.length > 0) {
            toast(`${result.skipped.length} ${t('error.conflict')}`, 'warning');
          }
          await renderTables(container);
        },
      }, t('common.create')),
    ],
  });
}

/* ------------------------------------------------------------ terminals */

export async function renderTerminals(container) {
  if (!can(Capability.TERMINALS_PROVISION)) {
    mount(container, pageHeader(t('terminals.title')), lockedPanel(Capability.TERMINALS_PROVISION));
    return;
  }

  const { terminals } = await api.get('/api/terminals');
  const canManage = has(Permission.TERMINALS_MANAGE);

  mount(container,
    pageHeader(t('terminals.title'),
      canManage
        ? h('button', { class: 'qs-btn qs-btn-primary', onClick: () => openTerminalForm(container, null) },
            t('terminals.add'))
        : null),

    h('p', { class: 'qs-muted' }, t('terminals.scan_hint')),

    terminals.length === 0
      ? h('div', { class: 'qs-card' }, h('div', { class: 'qs-empty' }, t('common.empty')))
      : h('div', { class: 'qs-grid qs-grid-cards qr-print-sheet' }, terminals.map((terminal) =>
          h('div', { class: 'qs-card' },
            h('div', { class: 'qs-card-head' },
              h('h3', { style: { margin: 0 } }, pick(terminal.name)),
              h('span', {
                class: `qs-badge ${terminal.online ? 'qs-badge-success' : ''}`,
              }, terminal.online ? t('common.online') : t('common.offline'))),
            h('p', { class: 'qs-small' },
              h('span', { class: 'qs-badge' }, typeLabel(terminal.type)),
              terminal.status !== 'ACTIVE'
                ? h('span', { class: 'qs-badge qs-badge-warning' }, t('common.disabled'))
                : null),
            h('p', { class: 'qs-xs qs-muted' },
              `${t('terminals.last_seen')}: `,
              terminal.lastSeenAt ? formatDateTime(terminal.lastSeenAt) : '—'),
            h('p', { class: 'qs-mono qs-xs' }, terminal.id),
            h('div', { class: 'qs-row no-print' },
              h('button', {
                class: 'qs-btn',
                onClick: () => void openQr(`/api/terminals/${terminal.id}/qr`,
                  pick(terminal.name), typeLabel(terminal.type)),
              }, t('terminals.qr')),
              canManage
                ? h('button', {
                    class: 'qs-btn qs-btn-ghost',
                    onClick: () => openTerminalForm(container, terminal),
                  }, t('common.edit'))
                : null)))));
}

function openTerminalForm(container, terminal) {
  const types = Object.values(TerminalType).filter((type) => type !== TerminalType.TABLE);
  const locales = enabledLocales();

  const form = h('form', {},
    languageNote(locales),
    localisedField(t('common.name'), 'name', terminal?.name ?? {}, { required: true }),

    terminal
      ? null
      : h('label', { class: 'qs-field' },
          h('span', {}, t('common.type')),
          h('select', { name: 'type' }, types.map((type) =>
            h('option', { value: type }, typeLabel(type))))),

    terminal
      ? h('label', { class: 'qs-check' },
          h('input', {
            type: 'checkbox', name: 'active', checked: terminal.status === 'ACTIVE',
          }),
          h('span', {}, t('common.enabled')))
      : null,

    terminal
      ? h('div', { style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
          h('div', { class: 'qs-section-title' }, t('sound.title')),
          soundEditor(terminal))
      : null);

  const dialog = modal({
    title: terminal ? pick(terminal.name) : t('terminals.add'),
    body: form,
    actions: [
      terminal
        ? h('button', {
            class: 'qs-btn', value: 'rotate', type: 'button',
            onClick: async () => {
              const ok = await confirmDialog({
                title: t('terminals.rotate_qr'),
                message: t('terminals.rotate_warning'),
                confirmLabel: t('terminals.rotate_qr'),
                cancelLabel: t('common.cancel'),
              });
              if (!ok) return;
              const done = await guard(() => api.post(`/api/terminals/${terminal.id}/rotate-qr`));
              if (done) toast(t('common.saved'), 'success');
            },
          }, t('terminals.rotate_qr'))
        : null,
      terminal
        ? h('button', {
            class: 'qs-btn qs-btn-danger', value: 'delete', type: 'button',
            onClick: async () => {
              const ok = await confirmDialog({
                title: t('common.delete'),
                message: pick(terminal.name),
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
              });
              if (!ok) return;
              const done = await guard(() => api.del(`/api/terminals/${terminal.id}`));
              if (!done) return;
              dialog.close();
              await renderTerminals(container);
            },
          }, t('common.delete'))
        : null,
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary', value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());

          const name = mergeLocalised(terminal?.name ?? {}, data, 'name');
          if (Object.keys(name).length === 0) {
            toast(t('error.validation'), 'error');
            return;
          }

          const payload = terminal
            ? { name, status: data.active === 'on' ? 'ACTIVE' : 'DISABLED', soundProfile: draftSound }
            : { name, type: data.type };

          const saved = await guard(() => terminal
            ? api.patch(`/api/terminals/${terminal.id}`, payload)
            : api.post('/api/terminals', payload));
          if (!saved) return;

          dialog.close();
          await renderTerminals(container);
        },
      }, t('common.save')),
    ],
  });
}

/* ---------------------------------------------------------------- sound */

let draftSound = null;

/**
 * Per-terminal alert settings (spec §21). Nothing here is hard-coded: a
 * restaurant chooses the tone, the volume, how many times it repeats, and
 * whether it keeps going until a cook acknowledges it.
 */
function soundEditor(terminal) {
  draftSound = JSON.parse(JSON.stringify(terminal.soundProfile ?? { enabled: false, masterVolume: 0.8, bindings: {} }));

  const events = ['new_order', 'order_ready', 'order_urgent', 'order_cancelled',
    'payment_success', 'payment_failed', 'notification', 'error'];

  return h('div', {},
    h('label', { class: 'qs-check' },
      h('input', {
        type: 'checkbox', checked: draftSound.enabled,
        onChange: (event) => { draftSound.enabled = event.target.checked; },
      }),
      h('span', {}, t('sound.enabled'))),

    h('label', { class: 'qs-field' },
      h('span', {}, t('sound.volume')),
      h('input', {
        type: 'range', min: '0', max: '1', step: '0.05',
        value: String(draftSound.masterVolume ?? 0.8),
        onInput: (event) => { draftSound.masterVolume = Number(event.target.value); },
      })),

    events.map((soundEvent) => {
      const binding = draftSound.bindings[soundEvent];
      return h('div', { class: 'qs-card qs-card-tight', style: { marginBlockEnd: '6px' } },
        h('label', { class: 'qs-check' },
          h('input', {
            type: 'checkbox', checked: Boolean(binding),
            onChange: (event) => {
              if (event.target.checked) {
                draftSound.bindings[soundEvent] = {
                  asset: 'builtin:chime', volume: 0.8,
                  repeatCount: 1, repeatIntervalMs: 1500, untilAcknowledged: false,
                };
              } else {
                delete draftSound.bindings[soundEvent];
              }
            },
          }),
          h('span', {}, t(`sound.event.${soundEvent}`))),
        binding
          ? h('div', { class: 'qs-grid qs-grid-3', style: { marginBlockStart: '6px' } },
              h('label', { class: 'qs-field' },
                h('span', {}, t('sound.repeat_count')),
                h('input', {
                  type: 'number', min: '1', max: '20', value: String(binding.repeatCount ?? 1),
                  onInput: (event) => { binding.repeatCount = Number(event.target.value); },
                })),
              h('label', { class: 'qs-field' },
                h('span', {}, t('sound.repeat_interval')),
                h('input', {
                  type: 'number', min: '1', max: '60',
                  value: String(Math.round((binding.repeatIntervalMs ?? 1500) / 1000)),
                  onInput: (event) => { binding.repeatIntervalMs = Number(event.target.value) * 1000; },
                })),
              h('label', { class: 'qs-check' },
                h('input', {
                  type: 'checkbox', checked: Boolean(binding.untilAcknowledged),
                  onChange: (event) => { binding.untilAcknowledged = event.target.checked; },
                }),
                h('span', { class: 'qs-xs' }, t('sound.until_acknowledged'))))
          : null);
    }));
}
