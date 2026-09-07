/**
 * Restaurant management console (spec §40).
 *
 * Served on loopback only, so this is the one screen a diner's phone can never
 * reach. It carries the whole owner-facing journey:
 *
 *     Install → create restaurant → create owner → build the real menu
 *             → activate a licence → operate
 *
 * SETUP and OPERATIONAL are the same console. Licence-gated sections stay
 * visible with a padlock and an explanation rather than disappearing, because
 * an owner deciding whether to buy needs to see what they are buying.
 */

import { boot, api, guard, t, toast } from '../shared/boot.js';
import { h, mount, modal } from '../shared/dom.js';
import { pick, availableLocales, setLocale } from '../shared/i18n.js';
import { applyTheme } from '../shared/theme.js';
import { Capability, grants, Permission } from '../shared/events.js';

import { renderMenuBuilder } from './views/menu.js';
import { renderTables, renderTerminals } from './views/service.js';
import { renderOrders, renderReports, renderActivityLog } from './views/orders.js';
import { renderSettings, renderUsers, renderPrinting, renderBackup, renderLicense } from './views/system.js';
import { renderLanguages, renderThemes } from './views/packs.js';
import { renderCurrencies } from './views/currencies.js';
import { renderLockScreen } from './views/lock.js';
import { renderDeveloper } from './views/developer.js';

export const state = {
  status: null,
  session: null,
  route: 'dashboard',
  realtime: null,
  notifications: null,
  /** Phone only: whether the navigation drawer is showing. */
  drawer: false,
};

/**
 * The five sections that earn a place under the thumb on a phone, in the order
 * an owner reaches for them. The rest stay one tap away behind the drawer.
 */
const PHONE_TABS = ['dashboard', 'orders', 'tables', 'menu', 'reports'];

const root = document.getElementById('app');

/* --------------------------------------------------------------- helpers */

export const has = (permission) => grants(state.session?.permissions ?? [], permission);
export const can = (capability) => (state.status?.capabilities ?? []).includes(capability);
export const isSetup = () => state.status?.mode === 'SETUP';
/** The languages this restaurant offers; every owner-written name is per-language. */
export const enabledLocales = () =>
  state.status?.locales?.filter((entry) => entry.enabled).map((entry) => entry.locale) ?? ['en'];

export async function refreshStatus() {
  state.status = await api.get('/api/system');
  state.session = await api.get('/api/auth/me');
}

/** Re-render the current route. Views call this after they change something. */
export async function reroute() {
  await refreshStatus();
  navigate(state.route);
}

/**
 * Locked-section placeholder. Explains what activating unlocks instead of
 * hiding the feature, and links straight to the licence screen.
 */
export function lockedPanel(capability) {
  return h('div', { class: 'qs-locked' },
    h('h2', {}, `🔒 ${t('setup.locked_feature')}`),
    h('p', { class: 'qs-muted' }, t('setup.locked_explain')),
    h('button', {
      class: 'qs-btn qs-btn-primary',
      onClick: () => navigate('license'),
    }, t('license.activate')),
    h('p', { class: 'qs-xs qs-muted', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
      capability));
}

export function pageHeader(title, ...actions) {
  return h('div', { class: 'qs-card-head' },
    h('h1', { style: { margin: 0 } }, title),
    h('div', { class: 'qs-row' }, actions));
}

/* ------------------------------------------------------------------ nav */

const NAV = [
  { route: 'dashboard', label: 'nav.dashboard' },
  { route: 'menu', label: 'nav.menu', permission: Permission.MENU_VIEW },
  { route: 'tables', label: 'nav.tables', permission: Permission.TABLES_VIEW, capability: Capability.TABLES_PROVISION },
  { route: 'terminals', label: 'nav.terminals', permission: Permission.TERMINALS_VIEW, capability: Capability.TERMINALS_PROVISION },
  { route: 'orders', label: 'nav.orders', permission: Permission.ORDERS_VIEW, capability: Capability.ORDERS_RUNTIME },
  { route: 'reports', label: 'nav.reports', permission: Permission.REPORTS_VIEW, capability: Capability.REPORTS_RUNTIME },
  { route: 'printing', label: 'nav.printing', permission: Permission.PRINTING_MANAGE, capability: Capability.PRINTING_RUNTIME },
  { route: 'users', label: 'nav.users', permission: Permission.USERS_MANAGE },
  { route: 'settings', label: 'nav.settings', permission: Permission.SETTINGS_MANAGE },
  { route: 'currencies', label: 'nav.currencies', permission: Permission.SETTINGS_MANAGE },
  { route: 'languages', label: 'nav.languages', permission: Permission.SETTINGS_MANAGE },
  { route: 'themes', label: 'nav.themes', permission: Permission.SETTINGS_MANAGE },
  { route: 'backup', label: 'nav.backup', permission: Permission.BACKUP_MANAGE },
  { route: 'activity', label: 'nav.activity', permission: Permission.AUDIT_VIEW },
  { route: 'license', label: 'nav.license', permission: Permission.LICENSE_MANAGE },
  // Only in a developer build; a restaurant's console never shows this.
  { route: 'developer', label: 'nav.developer', permission: Permission.SETTINGS_MANAGE,
    developerOnly: true },
];

const VIEWS = {
  dashboard: renderDashboard,
  menu: renderMenuBuilder,
  tables: renderTables,
  terminals: renderTerminals,
  orders: renderOrders,
  reports: renderReports,
  printing: renderPrinting,
  users: renderUsers,
  settings: renderSettings,
  currencies: renderCurrencies,
  languages: renderLanguages,
  themes: renderThemes,
  backup: renderBackup,
  activity: renderActivityLog,
  license: renderLicense,
  developer: renderDeveloper,
};

export function navigate(route) {
  state.route = VIEWS[route] ? route : 'dashboard';
  // Following a link closes the drawer; leaving it open over the page the
  // person just asked for would be the wrong answer to their tap.
  state.drawer = false;
  location.hash = `#/${state.route}`;
  renderShell();
}

/**
 * The phone's bottom bar: the five most-reached sections this person is
 * allowed, so a cashier never gets a tab that answers 403.
 */
function bottomTabs() {
  const allowed = visibleNav();
  const tabs = PHONE_TABS
    .map((route) => allowed.find((entry) => entry.route === route))
    .filter(Boolean);

  // Whatever the five leave out is reachable from here.
  const more = { route: '__more', label: 'common.more', mark: '☰' };

  return h('nav', { class: 'shell-tabs' },
    [...tabs, more].map((entry) => h('button', {
      class: 'shell-tab',
      'aria-current': state.route === entry.route ? 'page' : 'false',
      onClick: () => {
        if (entry.route === '__more') {
          state.drawer = true;
          renderShell();
          return;
        }
        navigate(entry.route);
      },
    },
      h('span', { class: 'shell-tab-mark' }, entry.mark ?? NAV_MARKS[entry.route] ?? '•'),
      h('span', { class: 'shell-tab-label' }, t(entry.label)))));
}

/**
 * One glyph per section. Text alone in a 64px-wide tab truncates to nonsense in
 * every language, so the glyph carries the meaning and the label confirms it.
 */
const NAV_MARKS = {
  dashboard: '◎', menu: '☰', tables: '▦', terminals: '▢', orders: '🧾',
  reports: '📈', printing: '🖨', users: '👤', settings: '⚙', currencies: '¤',
  languages: '文', themes: '◐', backup: '💾', activity: '🕘', license: '🔑',
  developer: '⚒',
};

/** The sections this person may actually open, in navigation order. */
function visibleNav() {
  return NAV
    .filter((entry) => !entry.developerOnly || state.status?.developerMode)
    .filter((entry) => !entry.permission || has(entry.permission));
}

function sidebar() {
  return h('nav', { class: 'shell-side', id: 'shell-side' },
    h('div', { class: 'shell-brand' },
      h('span', { class: 'shell-mark' }, 'QS'),
      h('div', {},
        h('strong', {}, pick(state.status?.restaurantName) || t('app.name')),
        h('small', {}, state.status?.restaurantId ?? ''))),

    visibleNav().map((entry) => {
      const locked = entry.capability !== undefined && !can(entry.capability);
      return h('button', {
        class: 'shell-nav-item',
        'aria-current': state.route === entry.route ? 'page' : 'false',
        'data-locked': String(locked),
        onClick: () => navigate(entry.route),
      },
        h('span', {}, t(entry.label)),
        locked ? h('span', { class: 'shell-lock' }, '🔒') : null);
    }),

    h('div', { class: 'qs-grow' }),

    // On a phone the topbar has no room for these, so the drawer holds them.
    h('div', { class: 'shell-side-controls', style: { padding: 'var(--qs-spacing-sm)' } },
      localePicker(),
      themePicker()),

    h('div', { class: 'qs-xs qs-muted', style: { padding: 'var(--qs-spacing-sm)' } },
      `${t('app.name')} ${state.status?.appVersion ?? ''}`));
}

/** The language picker, wherever it is being shown. */
function localePicker() {
  const locales = availableLocales();
  if (locales.length < 2) return null;

  return h('select', {
    'aria-label': t('common.language'),
    style: { width: 'auto' },
    onChange: async (event) => {
      await setLocale(event.target.value);
      renderShell();
    },
  }, locales.map((entry) =>
    h('option', { value: entry.locale, selected: entry.locale === document.documentElement.lang },
      entry.name)));
}

function themePicker() {
  return h('select', {
    'aria-label': t('common.theme'),
    style: { width: 'auto' },
    onChange: async (event) => { await applyTheme(event.target.value); },
  }, (state.status.themes ?? []).map((theme) =>
    h('option', { value: theme.id, selected: theme.active }, theme.name)));
}

/**
 * A manager talking to the floor.
 *
 * It reaches every station that has a person at it — not the tables, which is
 * the one audience a message like this must never reach.
 */
function broadcastButton() {
  if (!has(Permission.ORDERS_VIEW)) return null;

  return h('button', {
    class: 'qs-icon-btn qs-desk-only',
    'aria-label': t('notify.send'),
    title: t('notify.send'),
    onClick: () => {
      const text = h('textarea', {
        rows: '3',
        maxlength: '400',
        placeholder: t('notify.to_floor'),
      });

      const dialog = modal({
        title: t('notify.send'),
        body: h('div', {},
          h('p', { class: 'qs-muted qs-small' }, t('notify.to_floor')),
          text),
        actions: [
          h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
          h('button', {
            class: 'qs-btn qs-btn-primary',
            value: 'send',
            onClick: async (event) => {
              event.preventDefault();
              const body = text.value.trim();
              if (body === '') return;
              const sent = await guard(() =>
                state.notifications.raise('BROADCAST', { body }));
              if (!sent) return;
              toast(t('common.saved'), 'success');
              dialog.close('send');
            },
          }, t('notify.send')),
        ],
      });
      setTimeout(() => text.focus(), 60);
    },
  }, '📣');
}

function topbar() {
  return h('header', { class: 'shell-topbar' },
    h('button', {
      class: 'qs-icon-btn qs-phone-only',
      'aria-label': t('common.menu'),
      'aria-expanded': String(state.drawer),
      onClick: () => { state.drawer = !state.drawer; renderShell(); },
    }, '☰'),

    h('span', { class: 'mode-badge', 'data-mode': state.status.mode },
      state.status.mode === 'SETUP' ? t('setup.mode_badge') : t('license.state.active')),

    state.status.lan.running
      ? h('span', { class: 'qs-badge qs-badge-success' }, state.status.lan.baseUrl ?? '')
      : h('span', { class: 'qs-badge qs-badge-warning' }, t('license.state.not_activated')),

    h('span', { class: 'qs-grow' }),

    state.notifications ? broadcastButton() : null,
    state.notifications ? state.notifications.bell() : null,
    localePicker(),
    themePicker(),

    state.session.user
      ? h('div', { class: 'qs-row' },
          h('span', { class: 'qs-muted qs-small' }, state.session.user.displayName),
          h('button', {
            class: 'qs-btn qs-btn-ghost',
            onClick: async () => {
              await api.post('/api/auth/logout');
              location.reload();
            },
          }, t('common.signout')))
      : null);
}

function renderShell() {
  const view = VIEWS[state.route] ?? renderDashboard;
  const body = h('div', { class: 'qs-page' });

  mount(root,
    h('div', { class: 'shell', 'data-drawer': state.drawer ? 'open' : 'closed' },
      sidebar(),
      state.drawer
        ? h('div', {
            class: 'shell-scrim',
            onClick: () => { state.drawer = false; renderShell(); },
          })
        : null,
      h('main', { class: 'shell-main' }, topbar(), body),
      bottomTabs()));

  // Views render asynchronously; the page frame is already on screen so the
  // console never flashes empty between routes.
  mount(body, h('div', { class: 'qs-empty' }, h('div', { class: 'qs-spinner', style: { margin: '0 auto' } })));
  void Promise.resolve(view(body)).catch((error) => {
    console.error('[console]', error);
    mount(body, h('div', { class: 'qs-card' }, h('p', { class: 'qs-muted' }, String(error.message ?? error))));
  });
}

/* ------------------------------------------------------------ dashboard */

async function renderDashboard(container) {
  const status = state.status;
  const stat = (value, label) =>
    h('div', { class: 'stat' },
      h('div', { class: 'stat-value' }, String(value)),
      h('div', { class: 'stat-label' }, label));

  const counts = { tables: 0, terminals: 0, products: 0, openOrders: 0 };
  if (has(Permission.MENU_VIEW)) {
    counts.products = (await api.get('/api/menu/products').catch(() => ({ products: [] }))).products.length;
  }
  if (can(Capability.TABLES_PROVISION) && has(Permission.TABLES_VIEW)) {
    counts.tables = (await api.get('/api/tables').catch(() => ({ tables: [] }))).tables.length;
  }
  if (can(Capability.TERMINALS_PROVISION) && has(Permission.TERMINALS_VIEW)) {
    counts.terminals = (await api.get('/api/terminals').catch(() => ({ terminals: [] }))).terminals.length;
  }
  if (can(Capability.ORDERS_RUNTIME) && has(Permission.ORDERS_VIEW)) {
    counts.openOrders = (await api.get('/api/orders?open=true').catch(() => ({ orders: [] }))).orders.length;
  }

  mount(container,
    pageHeader(t('nav.dashboard')),

    isSetup()
      ? h('div', { class: 'qs-card', style: { marginBlockEnd: 'var(--qs-spacing-lg)' } },
          h('h2', {}, t('setup.title')),
          h('p', { class: 'qs-muted' }, t('setup.intro')),
          h('div', { class: 'qs-row' },
            h('button', { class: 'qs-btn qs-btn-primary', onClick: () => navigate('menu') },
              t('menu.builder')),
            h('button', { class: 'qs-btn', onClick: () => navigate('license') },
              t('license.activate'))))
      : null,

    h('div', { class: 'stat-grid' },
      stat(counts.products, t('menu.products')),
      stat(counts.tables, t('nav.tables')),
      stat(counts.terminals, t('nav.terminals')),
      stat(counts.openOrders, t('tables.open_orders'))),

    h('div', { class: 'qs-grid qs-grid-2', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
      h('div', { class: 'qs-card' },
        h('h3', {}, t('license.title')),
        h('p', {},
          h('span', { class: 'qs-badge qs-badge-text' }, t(status.license.explanation)),
          status.license.licenseId ? h('span', { class: 'qs-mono' }, ` ${status.license.licenseId}`) : null),
        h('p', { class: 'qs-small qs-muted' },
          `${t('license.restaurant_id')}: ${status.restaurantId ?? '—'}`, h('br'),
          `${t('license.transfers')}: ${status.license.transferCount}`),
        h('button', { class: 'qs-btn', onClick: () => navigate('license') }, t('nav.license'))),

      h('div', { class: 'qs-card' },
        h('h3', {}, t('nav.terminals')),
        status.lan.running
          ? h('div', {},
              h('p', { class: 'qs-mono qs-small' }, status.lan.baseUrl),
              h('p', { class: 'qs-small qs-muted' },
                `${t('common.online')}: ${status.lan.addresses.join(', ') || '—'}`),
              status.lan.advertising
                ? h('p', { class: 'qs-small qs-muted' }, `mDNS: ${status.lan.hostname}`)
                : h('p', { class: 'qs-small qs-muted' },
                    `mDNS unavailable — ${status.lan.discoveryError ?? 'using IP address'}`))
          : h('p', { class: 'qs-muted' }, t('setup.locked_explain')))));
}

/* ------------------------------------------------------- first-run flow */

/**
 * The install wizard. Runs only while the installation has no restaurant or no
 * owner account; after that this code never executes again.
 */
async function renderWizard(status) {
  const needsRestaurant = !status.setupComplete;
  const step = needsRestaurant ? 0 : 1;

  const form = h('form', { class: 'qs-card' });
  const submit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());

    const ok = await guard(async () => {
      if (needsRestaurant) {
        await api.post('/api/setup/restaurant', {
          name: { '*': String(data.name).trim() },
          defaultLocale: data.defaultLocale,
          themeId: data.themeId,
        });
      } else {
        await api.post('/api/setup/owner', {
          username: String(data.username).trim(),
          displayName: String(data.displayName).trim(),
          password: String(data.password),
        });
        await api.post('/api/auth/login', {
          username: String(data.username).trim(),
          password: String(data.password),
        });
      }
      return true;
    });
    if (ok) location.reload();
  };
  form.addEventListener('submit', submit);

  const locales = (status.locales ?? []).map((entry) =>
    h('option', { value: entry.locale }, `${entry.name} (${entry.englishName})`));
  const themes = (status.themes ?? []).map((theme) =>
    h('option', { value: theme.id }, theme.name));

  mount(form,
    h('div', { class: 'wizard-steps' },
      h('span', { 'data-done': 'true' }),
      h('span', { 'data-done': String(step >= 1) }),
      h('span', { 'data-done': 'false' })),

    h('h1', {}, t('setup.title')),
    h('p', { class: 'qs-muted' }, t('setup.intro')),

    needsRestaurant
      ? h('div', {},
          h('label', { class: 'qs-field' },
            h('span', {}, t('setup.restaurant_name')),
            h('input', { name: 'name', required: true, autofocus: true, maxlength: '200' })),
          h('label', { class: 'qs-field' },
            h('span', {}, t('settings.default_language')),
            h('select', { name: 'defaultLocale' }, locales)),
          h('label', { class: 'qs-field' },
            h('span', {}, t('common.theme')),
            h('select', { name: 'themeId' }, themes)),
          h('button', { class: 'qs-btn qs-btn-primary qs-btn-block', type: 'submit' },
            t('setup.create_restaurant')))
      : h('div', {},
          h('h2', {}, t('setup.owner_account')),
          h('label', { class: 'qs-field' },
            h('span', {}, t('setup.display_name')),
            h('input', { name: 'displayName', required: true, autofocus: true, maxlength: '80' })),
          h('label', { class: 'qs-field' },
            h('span', {}, t('common.username')),
            h('input', { name: 'username', required: true, pattern: '[a-zA-Z0-9._\\-]{3,40}', autocomplete: 'username' })),
          h('label', { class: 'qs-field' },
            h('span', {}, t('common.password')),
            // The rule is the server's; saying it here is what stops a person
            // typing four digits and wondering why nothing happens.
            h('span', { class: 'qs-xs qs-muted' }, t('setup.owner_password_hint')),
            h('input', {
              name: 'password', type: 'password', required: true, minlength: '8',
              autocomplete: 'new-password', title: t('setup.owner_password_hint'),
            })),
          h('button', { class: 'qs-btn qs-btn-primary qs-btn-block', type: 'submit' },
            t('setup.create_owner'))));

  mount(root, h('div', { class: 'wizard' }, form));
}

async function renderLogin() {
  const form = h('form', { class: 'qs-card' });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const ok = await guard(() => api.post('/api/auth/login', {
      username: String(data.username).trim(),
      password: String(data.password),
    }));
    if (ok) location.reload();
  });

  mount(form,
    h('h1', {}, t('app.name')),
    h('p', { class: 'qs-muted' }, t('app.tagline')),
    h('label', { class: 'qs-field' },
      h('span', {}, t('common.username')),
      h('input', { name: 'username', required: true, autofocus: true, autocomplete: 'username' })),
    h('label', { class: 'qs-field' },
      h('span', {}, t('common.password')),
      h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    h('button', { class: 'qs-btn qs-btn-primary qs-btn-block', type: 'submit' }, t('common.signin')));

  mount(root, h('div', { class: 'wizard' }, form));
}

/* ------------------------------------------------------------------ boot */

async function main() {
  // The lock comes first, before a session is resolved or any restaurant data
  // is fetched: while it holds, the server refuses everything else anyway.
  const lock = await api.get('/api/lock').catch(() => null);
  if (lock?.locked) {
    await renderLockScreen(root, lock);
    return;
  }

  const started = await boot({ topics: ['system', 'orders', 'tables', 'terminals', 'menu'] });
  state.session = started.session;
  state.realtime = started.realtime;
  state.notifications = started.notifications;
  state.status = await api.get('/api/system');

  // Three distinct first-run states, in the order an owner meets them.
  if (!state.status.setupComplete || !state.status.ownerExists) {
    await renderWizard(state.status);
    return;
  }
  if (!state.session.user) {
    await renderLogin();
    return;
  }

  const initial = location.hash.replace(/^#\/?/, '');
  state.route = VIEWS[initial] ? initial : 'dashboard';
  renderShell();

  window.addEventListener('hashchange', () => {
    const route = location.hash.replace(/^#\/?/, '');
    if (route && route !== state.route) navigate(route);
  });

  // Activating a licence changes what the whole console can do, so the frame
  // and the current view both refresh the moment the mode flips.
  state.realtime.on('system.mode_changed', () => {
    void refreshStatus().then(() => {
      renderShell();
      toast(t('license.state.active'), 'success');
    });
  });
}

void main().catch((error) => console.error('[console]', error));
