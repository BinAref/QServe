/**
 * Settings, users and roles, printing, backup, and the licence screen.
 *
 * The licence screen is the commercial heart of the product, and it is written
 * to be honest: it names the device, explains in plain language why the
 * installation is in SETUP, lists exactly which capabilities activation
 * unlocks, and never pretends the restaurant's data is at risk.
 */

import { api, guard, t, toast, roleLabel, setRoleNames } from '../../shared/boot.js';
import { h, mount, modal, confirmDialog, entered } from '../../shared/dom.js';
import { pick, te, formatDateTime, formatMoney } from '../../shared/i18n.js';
import { localisedField, mergeLocalised, languageNote } from '../../shared/fields.js';
import { Capability, Permission, PrintDocumentType, PrinterTransport } from '../../shared/events.js';
import {
  state, has, can, isSetup, pageHeader, lockedPanel, refreshStatus, navigate, enabledLocales,
} from '../app.js';

/* -------------------------------------------------------------- settings */

/**
 * Settings.
 *
 * This screen used to be one page two and a half thousand pixels long with
 * forty-nine controls on it, which is not a settings screen — it is an inventory
 * of every decision anyone ever made, handed to somebody looking for one of
 * them. It is five jobs, so it is five sections, and one is shown at a time.
 */
const SETTINGS_SECTIONS = [
  { id: 'restaurant', label: 'settings.restaurant' },
  { id: 'money', label: 'settings.currency' },
  { id: 'appearance', label: 'settings.appearance' },
  { id: 'operations', label: 'settings.operations' },
  { id: 'lock', label: 'lock.title' },
];

let settingsSection = 'restaurant';

export async function renderSettings(container) {
  const [restaurant, settingsResult, lock] = await Promise.all([
    api.get('/api/restaurant'),
    api.get('/api/settings'),
    api.get('/api/lock').catch(() => null),
  ]);
  const settings = settingsResult.settings;
  const locales = state.status.locales ?? [];
  const themes = state.status.themes ?? [];
  const canEdit = has(Permission.SETTINGS_MANAGE);

  /** Save only what this section owns; the rest of the profile is untouched. */
  const savePatch = async (patch) => {
    const saved = await guard(() => api.patch('/api/restaurant', patch));
    if (!saved) return;
    toast(t('common.saved'), 'success');
    await refreshStatus();
    await renderSettings(container);
  };

  const body = h('div', {});
  const paint = () => {
    entered(body);
    if (settingsSection === 'restaurant') mount(body, restaurantPanel(restaurant, canEdit, savePatch));
    else if (settingsSection === 'money') mount(body, moneyPanel(restaurant, canEdit, savePatch));
    else if (settingsSection === 'appearance') {
      mount(body, appearancePanel(restaurant, locales, themes, canEdit, savePatch));
    } else if (settingsSection === 'operations') {
      mount(body, operationalSettings(settings, canEdit, container));
    } else {
      mount(body, lock ? appLockPanel(lock, canEdit, container) : null);
    }
  };

  mount(container,
    pageHeader(t('settings.title')),
    h('div', { class: 'qs-tabs', role: 'tablist' },
      SETTINGS_SECTIONS.map((section) => h('button', {
        class: 'qs-tab',
        role: 'tab',
        'aria-selected': String(section.id === settingsSection),
        onClick: (event) => {
          settingsSection = section.id;
          for (const tab of event.target.parentElement.children) {
            tab.setAttribute('aria-selected', String(tab === event.target));
          }
          paint();
        },
      }, t(section.label)))),
    body);

  paint();
}

/**
 * Whether this computer asks for a password when QServe opens.
 *
 * The tables, the kitchen and the till keep working while the console is
 * locked: locking a manager's screen must never close a restaurant.
 */
function appLockPanel(lock, canEdit, container) {
  const form = h('form', { class: 'qs-card' });

  const enableCheck = h('input', {
    type: 'checkbox', name: 'enabled', checked: lock.enabled, disabled: !canEdit,
  });
  const fields = h('div', { class: lock.enabled ? '' : 'qs-hidden' });
  enableCheck.addEventListener('change', () => {
    fields.classList.toggle('qs-hidden', !enableCheck.checked);
  });

  mount(fields,
    h('div', { class: 'qs-grid qs-grid-2' },
      h('label', { class: 'qs-field' },
        h('span', {}, t('lock.new_password')),
        h('input', {
          name: 'passphrase', type: 'password', minlength: '4', maxlength: '200',
          autocomplete: 'new-password', disabled: !canEdit,
        }),
        lock.enabled ? h('small', { class: 'qs-muted' }, t('lock.keep_password')) : null),
      h('label', { class: 'qs-field' },
        h('span', {}, t('lock.confirm_password')),
        h('input', {
          name: 'confirm', type: 'password', maxlength: '200',
          autocomplete: 'new-password', disabled: !canEdit,
        }))),

    h('div', { class: 'qs-grid qs-grid-2' },
      h('label', { class: 'qs-field' },
        h('span', {}, t('lock.hint')),
        h('input', { name: 'hint', maxlength: '120', value: lock.hint ?? '', disabled: !canEdit }),
        h('small', { class: 'qs-muted' }, t('lock.hint_help'))),
      h('label', { class: 'qs-field' },
        h('span', {}, t('lock.idle_minutes')),
        h('input', {
          name: 'idleMinutes', type: 'number', min: '1', max: '1440',
          value: String(lock.idleMinutes ?? 30), disabled: !canEdit,
        }))));

  mount(form,
    h('h2', {}, t('lock.title')),
    h('p', { class: 'qs-muted' }, t('lock.subtitle')),

    h('p', {},
      h('span', {
        class: `qs-badge qs-badge-text${lock.enabled ? ' qs-badge-success' : ''}`,
      },
        t(lock.enabled ? 'lock.enabled' : 'lock.disabled'))),

    h('label', { class: 'qs-check' }, enableCheck, h('span', {}, t('lock.enable'))),
    fields,

    lock.enabled
      ? h('label', { class: 'qs-field' },
          h('span', {}, t('lock.current_password')),
          h('input', {
            name: 'currentPassphrase', type: 'password', maxlength: '200',
            autocomplete: 'current-password', disabled: !canEdit,
          }),
          h('small', { class: 'qs-muted' }, t('lock.current_required')))
      : null,

    h('p', { class: 'qs-xs qs-muted' },
      t('lock.terminals_unaffected'), ' ', t('lock.restart_note')),

    canEdit
      ? h('div', { class: 'qs-row' },
          h('button', { class: 'qs-btn qs-btn-primary', type: 'submit' }, t('common.save')),
          lock.enabled
            ? h('button', {
                class: 'qs-btn', type: 'button',
                onClick: async () => {
                  const done = await guard(() => api.post('/api/lock/engage'));
                  if (done) location.reload();
                },
              }, t('lock.lock_now'))
            : null)
      : null);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const passphrase = String(data.passphrase ?? '');

    if (passphrase !== '' && passphrase !== String(data.confirm ?? '')) {
      toast(t('lock.mismatch'), 'error');
      return;
    }
    if (data.enabled === 'on' && !lock.enabled && passphrase.length < 4) {
      toast(t('lock.too_short'), 'error');
      return;
    }

    const saved = await guard(() => api.put('/api/lock/settings', {
      enabled: data.enabled === 'on',
      passphrase,
      currentPassphrase: String(data.currentPassphrase ?? ''),
      hint: String(data.hint ?? '').trim() || null,
      idleMinutes: Number(data.idleMinutes ?? 30),
    }));
    if (!saved) return;

    toast(t('common.saved'), 'success');
    // Any change clears every unlock session, this one included, so the honest
    // thing to do is send the owner straight to the lock screen.
    if (saved.enabled) location.reload();
    else await renderSettings(container);
  });

  return form;
}

/** Who the restaurant is. The name a diner reads, and how to reach it. */
function restaurantPanel(restaurant, canEdit, savePatch) {
  // Five boxes of the same width in two columns. The name used to run the whole
  // card while the phone number sat in a third of it — the same form, three
  // widths, for no reason a person could name.
  const form = h('form', { class: 'qs-card' },
    h('div', { class: 'qs-grid qs-grid-2' },
      localisedField(t('setup.restaurant_name'), 'name', restaurant.name),
      field(t('settings.address'), 'address', restaurant.address),
      field(t('settings.phone'), 'phone', restaurant.phone),
      field(t('settings.email'), 'email', restaurant.email),
      field(t('settings.tax_number'), 'taxNumber', restaurant.taxNumber)),
    languageNote(enabledLocales()),

    canEdit ? h('button', { class: 'qs-btn qs-btn-primary', type: 'submit' }, t('common.save')) : null);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const name = mergeLocalised(restaurant.name, data, 'name');
    void savePatch({
      ...(Object.keys(name).length > 0 ? { name } : {}),
      address: String(data.address ?? '').trim() || null,
      phone: String(data.phone ?? '').trim() || null,
      email: String(data.email ?? '').trim() || null,
      taxNumber: String(data.taxNumber ?? '').trim() || null,
    });
  });
  return form;
}

/** What the restaurant counts in, and what it adds to a bill. */
function moneyPanel(restaurant, canEdit, savePatch) {
  const form = h('form', { class: 'qs-card' },
    h('div', { class: 'qs-panel-head' },
      h('h2', {}, t('settings.currency')),
      h('p', {}, t('settings.money_intro'))),

    h('div', { class: 'qs-grid qs-grid-3' },
      field(t('currencies.code'), 'currencyCode', restaurant.currency.code),
      field(t('currencies.symbol'), 'currencySymbol', restaurant.currency.symbol),
      h('label', { class: 'qs-field' },
        h('span', {}, t('currencies.decimals')),
        h('input', {
          name: 'currencyDecimals', type: 'number', min: '0', max: '4',
          value: String(restaurant.currency.decimals),
        }))),

    h('div', { class: 'qs-rows' },
      h('div', { class: 'qs-row-item' },
        h('div', {},
          h('div', { class: 'qs-row-label' }, t('settings.tax_rate')),
          h('p', { class: 'qs-row-hint' }, t('settings.tax_rate_hint'))),
        h('div', { class: 'qs-row-control' },
          h('input', {
            name: 'taxRatePercent', type: 'number', step: '0.01', min: '0', max: '100',
            value: String(restaurant.taxRatePercent),
          }), '%')),

      h('div', { class: 'qs-row-item' },
        h('div', {},
          h('div', { class: 'qs-row-label' }, t('settings.service_rate')),
          h('p', { class: 'qs-row-hint' }, t('settings.service_rate_hint'))),
        h('div', { class: 'qs-row-control' },
          h('input', {
            name: 'serviceRatePercent', type: 'number', step: '0.01', min: '0', max: '100',
            value: String(restaurant.serviceRatePercent),
          }), '%')),

      h('label', { class: 'qs-row-item' },
        h('div', {},
          h('div', { class: 'qs-row-label' }, t('settings.tax_inclusive')),
          h('p', { class: 'qs-row-hint' }, t('settings.tax_inclusive_hint'))),
        h('div', { class: 'qs-row-control' },
          h('input', { type: 'checkbox', name: 'taxInclusive', checked: restaurant.taxInclusive })))),

    h('p', { class: 'qs-summary' },
      t('settings.more_currencies'), ' ',
      h('button', {
        class: 'qs-btn qs-btn-ghost qs-btn-sm', type: 'button',
        onClick: () => navigate('currencies'),
      }, t('nav.currencies'))),

    canEdit ? h('button', { class: 'qs-btn qs-btn-primary', type: 'submit' }, t('common.save')) : null);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    void savePatch({
      currency: {
        code: String(data.currencyCode).toUpperCase(),
        symbol: String(data.currencySymbol),
        decimals: Number(data.currencyDecimals),
        symbolPosition: restaurant.currency.symbolPosition,
      },
      taxRatePercent: Number(data.taxRatePercent),
      serviceRatePercent: Number(data.serviceRatePercent),
      taxInclusive: data.taxInclusive === 'on',
    });
  });
  return form;
}

/** What it looks like, and which languages a diner may read it in. */
function appearancePanel(restaurant, locales, themes, canEdit, savePatch) {
  const form = h('form', { class: 'qs-card' },
    h('div', { class: 'qs-grid qs-grid-2' },
      h('label', { class: 'qs-field' },
        h('span', {}, t('common.theme')),
        h('select', { name: 'themeId' }, themes.map((theme) =>
          h('option', { value: theme.id, selected: theme.id === restaurant.themeId }, theme.name)))),
      h('label', { class: 'qs-field' },
        h('span', {}, t('settings.default_language')),
        h('select', { name: 'defaultLocale' }, locales.map((entry) =>
          h('option', { value: entry.locale, selected: entry.locale === restaurant.defaultLocale },
            entry.name))))),

    h('div', { class: 'qs-panel-head', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
      h('h2', {}, t('settings.enabled_languages')),
      h('p', {}, t('settings.enabled_languages_hint'))),

    // Any installed language can be offered to diners; adding one is dropping
    // a file into locales/ (spec §32).
    h('div', { class: 'qs-rows' }, locales.map((entry) =>
      h('label', { class: 'qs-row-item' },
        h('div', {},
          h('div', { class: 'qs-row-label' }, entry.name),
          // "ltr" is a value in a file, not a word: the direction is written
          // out in the same sentence as the language's English name.
          h('p', { class: 'qs-row-hint' },
            `${entry.englishName} · `,
            t(entry.direction === 'rtl' ? 'languages.direction_rtl' : 'languages.direction_ltr'))),
        h('div', { class: 'qs-row-control' },
          h('input', {
            type: 'checkbox', name: `locale.${entry.locale}`,
            checked: restaurant.enabledLocales.includes(entry.locale),
          }))))),

    canEdit ? h('button', { class: 'qs-btn qs-btn-primary', type: 'submit' }, t('common.save')) : null);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const chosen = locales
      .filter((entry) => data[`locale.${entry.locale}`] === 'on')
      .map((entry) => entry.locale);
    void savePatch({
      themeId: data.themeId,
      defaultLocale: data.defaultLocale,
      ...(chosen.length > 0 ? { enabledLocales: chosen } : {}),
    });
  });
  return form;
}

function field(label, name, value) {
  return h('label', { class: 'qs-field' },
    h('span', {}, label),
    h('input', { name, value: value ?? '' }));
}

/**
 * The behavioural switches. Rendered from whatever keys the server reports, so
 * a module adding a setting needs no console change — but every switch says
 * what it does in the reader's language, and says it in a sentence.
 *
 * `orders.autoAcceptFromCustomer` is a name for the code to use. The owner sees
 * "Accept diners' orders automatically", and underneath it what that will mean
 * in their restaurant. A setting nobody has written a sentence for yet falls
 * back to its own name spaced out, which is ugly enough to get noticed and
 * caught by `npm run validate:audit`'s sibling check.
 */
const HIDDEN_SETTINGS = ['backup.passphrase', 'security.', 'license.'];

/** `orders.autoAcceptFromCustomer` → `setting.orders.auto_accept_from_customer`. */
const settingKey = (key) => {
  const [group, ...rest] = key.split('.');
  return `setting.${group}.${rest.join('.').replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()}`;
};

function settingLabel(key) {
  const label = t(settingKey(key));
  if (!label.startsWith('setting.')) return label;
  // Last resort: "autoAcceptFromCustomer" → "Auto accept from customer".
  const tail = key.split('.').slice(1).join('.');
  const spaced = tail.replace(/(?<!^)(?=[A-Z])/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function settingHint(key) {
  const hint = t(`${settingKey(key)}.hint`);
  return hint.startsWith('setting.') ? null : hint;
}

function settingGroupLabel(group) {
  const label = t(`settings.group.${group}`);
  return label.startsWith('settings.group.') ? group : label;
}

function operationalSettings(settings, canEdit, container) {
  const groups = new Map();
  for (const [key, value] of Object.entries(settings)) {
    // Credentials and machine-managed caches are not preferences: they have
    // their own screens above, and a raw text box would be the wrong shape.
    if (HIDDEN_SETTINGS.some((prefix) => key.startsWith(prefix))) continue;
    const group = key.split('.')[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([key, value]);
  }

  /** One switch or one number, with the sentence that explains it. */
  const row = (key, value) => {
    const control = typeof value === 'boolean'
      ? h('input', { type: 'checkbox', name: key, checked: value, disabled: !canEdit })
      : h('input', {
          name: key,
          type: typeof value === 'number' ? 'number' : 'text',
          inputmode: typeof value === 'number' ? 'numeric' : undefined,
          value: value === null ? '' : String(value),
          disabled: !canEdit,
        });

    const hint = settingHint(key);
    return h('label', { class: 'qs-row-item' },
      h('div', {},
        h('div', { class: 'qs-row-label' }, settingLabel(key)),
        hint ? h('p', { class: 'qs-row-hint' }, hint) : null),
      h('div', { class: 'qs-row-control' }, control));
  };

  /*
   * Nine areas, closed. An owner comes here for one of them — "stop printing a
   * receipt every time" — and a wall of twenty-two switches makes them read all
   * twenty-two to find it. The summary says what is inside so the right one can
   * be opened without hunting.
   */
  const form = h('form', { class: 'qs-card' },
    h('div', { class: 'qs-panel-head' },
      h('h2', {}, t('settings.operations')),
      h('p', {}, t('settings.operations_intro'))),

    [...groups.entries()].map(([group, entries]) => {
      const on = entries.filter(([, value]) => value === true).length;
      const switches = entries.filter(([, value]) => typeof value === 'boolean').length;

      return h('details', { class: 'qs-details' },
        h('summary', {},
          h('span', { class: 'qs-row-label' }, settingGroupLabel(group)),
          h('span', { class: 'qs-summary', style: { marginInlineStart: 'var(--qs-spacing-sm)' } },
            switches > 0
              ? t('settings.group_summary', { on, of: switches })
              : t('settings.group_count', { count: entries.length }))),
        h('div', { class: 'qs-rows' }, entries.map(([key, value]) => row(key, value))));
    }),

    canEdit
      ? h('button', {
          class: 'qs-btn qs-btn-primary', type: 'submit',
          style: { marginBlockStart: 'var(--qs-spacing-lg)' },
        }, t('common.save'))
      : null);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = {};

    for (const [key, value] of Object.entries(settings)) {
      if (HIDDEN_SETTINGS.some((prefix) => key.startsWith(prefix))) continue;
      if (typeof value === 'boolean') payload[key] = data.get(key) === 'on';
      else if (typeof value === 'number') payload[key] = Number(data.get(key));
      else {
        const raw = data.get(key);
        payload[key] = raw === null || raw === '' ? null : String(raw);
      }
    }

    const saved = await guard(() => api.patch('/api/settings', payload));
    if (!saved) return;
    toast(t('common.saved'), 'success');
    await renderSettings(container);
  });

  return form;
}

/* ------------------------------------------------------- users and roles */

/**
 * Roles have two halves and they belong to different people.
 *
 * The **name** is the restaurant's: one owner's waiter is another's host, and
 * the word they choose here is the word every screen uses — the floor tablet's
 * heading, the station list, the button a diner presses to call someone.
 *
 * The **permissions** of a built-in role are the system's. A cashier means the
 * same thing in every restaurant that runs QServe, whatever the badge says, and
 * an owner cannot accidentally hand the till's powers to the room. A restaurant
 * that needs a different set of powers adds a role of its own, which it then
 * owns outright — name and permissions both.
 */
export async function renderUsers(container) {
  const [{ users }, roleResult] = await Promise.all([
    api.get('/api/users'),
    api.get('/api/roles'),
  ]);
  const { roles, availablePermissions } = roleResult;
  // This list is the truth about what the restaurant calls its people, and the
  // console is where those names are changed — so every other screen in this
  // tab takes them from here rather than from a session fetched at load.
  setRoleNames(Object.fromEntries(
    roles.filter((role) => Object.keys(role.name ?? {}).length > 0)
      .map((role) => [role.key, role.name]),
  ));
  const canManage = has(Permission.USERS_MANAGE);
  const canManageRoles = has(Permission.ROLES_MANAGE);
  const byKey = new Map(roles.map((role) => [role.key, role]));
  const label = (key) => roleLabel(byKey.get(key) ?? key);

  mount(container,
    pageHeader(t('users.title'),
      canManage
        ? h('button', { class: 'qs-btn qs-btn-primary', onClick: () => openUserForm(container, null, roles) },
            t('users.add'))
        : null),

    h('div', { class: 'qs-card qs-narrow' },
      h('div', { class: 'qs-table-wrap' },
        h('table', { class: 'qs-table qs-table-clickable' },
          h('thead', {}, h('tr', {},
            h('th', {}, t('common.name')),
            h('th', {}, t('common.username')),
            h('th', {}, t('users.roles')),
            h('th', {}, t('common.status')),
            h('th', {}, t('users.last_login')))),
          h('tbody', {}, users.map((user) =>
            h('tr', { onClick: () => canManage && openUserForm(container, user, roles) },
              h('td', {}, user.displayName),
              h('td', { class: 'qs-mono qs-small' }, user.username),
              h('td', {}, user.roleKeys.map((key) =>
                h('span', { class: 'qs-badge', style: { marginInlineEnd: '4px' } }, label(key)))),
              h('td', {},
                h('span', { class: `qs-badge ${user.active ? 'qs-badge-success' : ''}` },
                  user.active ? t('common.enabled') : t('common.disabled'))),
              h('td', { class: 'qs-muted qs-small' },
                user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'))))))),

    h('div', { class: 'qs-card qs-narrow', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
      h('div', { class: 'qs-row qs-row-between' },
        h('h2', {}, t('users.roles')),
        canManageRoles
          ? h('button', {
              class: 'qs-btn qs-btn-ghost',
              onClick: () => openRoleForm(container, null, availablePermissions, roles),
            }, t('users.add_role'))
          : null),
      // The point worth making to an owner, in a sentence rather than a word:
      // these are real grants, checked on every request.
      h('p', { class: 'qs-muted qs-small' }, t('users.roles_intro')),
      /*
       * A role is a name and a size, not a word cloud. Printing every grant on
       * every card put sixty-one chips on this screen, which is a list nobody
       * reads and a page nobody scans. The card says what the role is and how
       * much it may do; the grants themselves are one click away, in the dialog
       * where they are edited anyway.
       */
      h('div', { class: 'qs-rows', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
        roles.map((role) => h('div', { class: 'qs-row-item' },
          h('div', {},
            h('div', { class: 'qs-row-label' },
              roleLabel(role),
              role.system
                ? null
                : h('span', { class: 'qs-badge qs-badge-accent' }, t('users.own_role'))),
            h('p', { class: 'qs-row-hint' },
              role.permissions.includes('*')
                ? t('users.all_permissions')
                : t('users.permission_count', { count: role.permissions.length }),
              ' · ',
              // The key never changes and staff never see it, but an owner who
              // has renamed three roles needs one fixed thing to know them by.
              h('span', { class: 'qs-mono qs-xs' }, role.key))),
          h('div', { class: 'qs-row-control' },
            canManageRoles
              ? h('button', {
                  class: 'qs-btn qs-btn-ghost',
                  onClick: () => openRoleForm(container, role, availablePermissions, roles),
                }, role.system ? t('users.rename') : t('common.edit'))
              : null))))));
}

function openUserForm(container, user, roles) {
  const form = h('form', {},
    h('label', { class: 'qs-field' },
      h('span', {}, t('setup.display_name')),
      h('input', { name: 'displayName', required: true, value: user?.displayName ?? '', maxlength: '80' })),
    user
      ? null
      : h('label', { class: 'qs-field' },
          h('span', {}, t('common.username')),
          h('input', { name: 'username', required: true, pattern: '[a-zA-Z0-9._\\-]{3,40}' })),
    h('label', { class: 'qs-field' },
      h('span', {}, user ? `${t('common.password')} / ${t('common.pin')} (${t('common.optional')})` : `${t('common.password')} / ${t('common.pin')}`),
      h('input', { name: 'password', type: 'password', minlength: '4', required: !user, autocomplete: 'new-password' })),
    h('div', { class: 'qs-field' },
      h('span', {}, t('users.roles')),
      roles.map((role) =>
        h('label', { class: 'qs-check' },
          h('input', {
            type: 'checkbox', name: `role.${role.key}`,
            checked: user?.roleKeys.includes(role.key) ?? false,
          }),
          h('span', {}, roleLabel(role))))),
    user
      ? h('label', { class: 'qs-check' },
          h('input', { type: 'checkbox', name: 'active', checked: user.active }),
          h('span', {}, t('common.enabled')))
      : null);

  const dialog = modal({
    title: user ? user.displayName : t('users.add'),
    body: form,
    actions: [
      user
        ? h('button', {
            class: 'qs-btn qs-btn-danger', value: 'delete', type: 'button',
            onClick: async () => {
              const ok = await confirmDialog({
                title: t('common.delete'),
                message: user.displayName,
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
              });
              if (!ok) return;
              const done = await guard(() => api.del(`/api/users/${user.id}`));
              if (!done) return;
              dialog.close();
              await renderUsers(container);
            },
          }, t('common.delete'))
        : null,
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary', value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());
          const roleKeys = roles.filter((role) => data[`role.${role.key}`] === 'on').map((role) => role.key);
          if (roleKeys.length === 0) {
            toast(t('error.validation'), 'error');
            return;
          }

          const payload = user
            ? {
                displayName: String(data.displayName).trim(),
                roleKeys,
                active: data.active === 'on',
                ...(data.password ? { password: String(data.password) } : {}),
              }
            : {
                username: String(data.username).trim(),
                displayName: String(data.displayName).trim(),
                password: String(data.password),
                roleKeys,
              };

          const saved = await guard(() => user
            ? api.patch(`/api/users/${user.id}`, payload)
            : api.post('/api/users', payload));
          if (!saved) return;
          dialog.close();
          await renderUsers(container);
        },
      }, t('common.save')),
    ],
  });
}

/* ----------------------------------------------------------- permissions */

/** `orders.change_status` → "Move an order along", in the reader's language. */
function permissionLabel(permission) {
  if (permission === '*') return '★ ' + t('users.all_permissions');
  const label = t(`permission.${permission}`);
  // Scope wildcards ("orders.*") and anything a future version adds have no
  // sentence of their own; the raw grant is honest and still readable.
  return label.startsWith('permission.') ? permission : label;
}

/** The heading a group of permissions sits under, in the restaurant's words. */
function permissionGroupLabel(group) {
  const key = group.toUpperCase();
  // "Kitchen", "Cashier" and "Waiter" are names this restaurant may have
  // changed; the rest are the product's own words.
  if (['KITCHEN', 'CASHIER', 'WAITER'].includes(key)) return roleLabel(key);
  const label = t(`permission.group.${group}`);
  return label.startsWith('permission.group.') ? group : label;
}

/** Permissions in the order they are granted in life, grouped by their area. */
function groupPermissions(permissions) {
  const groups = new Map();
  for (const permission of permissions) {
    const group = permission.split('.')[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(permission);
  }
  return [...groups.entries()];
}

/* ----------------------------------------------------------------- roles */

/**
 * One dialog for both halves, because an owner opening a role wants to see the
 * whole of it. On a built-in role the permissions are shown and locked, with
 * the reason next to them rather than in a manual nobody reads.
 */
function openRoleForm(container, role, availablePermissions, roles) {
  const locales = enabledLocales();
  const creating = role === null;
  const system = role?.system ?? false;
  const wildcard = role?.permissions.includes('*') ?? false;
  const locked = system || wildcard;

  const form = h('form', {},
    localisedField(t('users.role_name'), 'name', role?.name ?? {}, {
      ...(system ? { placeholder: shippedRoleLabel(role.key), hint: t('users.role_name_hint') } : {}),
    }),
    languageNote(locales),

    h('p', { class: 'qs-muted qs-small' },
      locked ? t('users.permissions_fixed') : t('users.custom_permissions')),

    h('div', { class: 'qs-permission-groups' },
      groupPermissions(availablePermissions).map(([group, permissions]) =>
        h('div', { class: 'qs-permission-group' },
          h('div', { class: 'qs-section-title' }, permissionGroupLabel(group)),
          permissions.map((permission) =>
            h('label', { class: 'qs-check' },
              h('input', {
                type: 'checkbox', name: permission,
                checked: wildcard || (role?.permissions.includes(permission) ?? false),
                disabled: locked,
              }),
              h('span', {}, permissionLabel(permission))))))));

  const dialog = modal({
    title: creating ? t('users.add_role') : roleLabel(role),
    body: form,
    actions: [
      // Only a role the restaurant added is the restaurant's to remove; the
      // built-in ones are what the rest of the product is written against.
      !creating && !system
        ? h('button', {
            class: 'qs-btn qs-btn-danger', type: 'button',
            onClick: async () => {
              const ok = await confirmDialog({
                title: t('common.delete'),
                message: roleLabel(role),
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
              });
              if (!ok) return;
              const done = await guard(() => api.del(`/api/roles/${role.id}`));
              if (!done) return;
              dialog.close();
              await renderUsers(container);
            },
          }, t('common.delete'))
        : null,
      // Handing a renamed built-in role back its shipped label, which then
      // follows the reader's language again instead of one owner's word.
      !creating && system && Object.keys(role.name ?? {}).length > 0
        ? h('button', {
            class: 'qs-btn', type: 'button',
            onClick: async () => {
              const done = await guard(() => api.patch(`/api/roles/${role.id}`, { name: null }));
              if (!done) return;
              dialog.close();
              await refreshStatus();
              await renderUsers(container);
            },
          }, t('users.use_default_name'))
        : null,
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary', value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(form).entries());
          const name = mergeLocalised(role?.name ?? {}, data, 'name');
          const permissions = availablePermissions.filter((permission) => data[permission] === 'on');

          if (creating) {
            if (Object.keys(name).length === 0 || permissions.length === 0) {
              toast(t(permissions.length === 0 ? 'users.no_permissions' : 'error.validation'), 'error');
              return;
            }
            const created = await guard(() => api.post('/api/roles', {
              key: newRoleKey(name, roles.map((entry) => entry.key)),
              name,
              permissions,
            }));
            if (!created) return;
          } else {
            // A built-in role's name is the only thing this form may change,
            // so nothing else is sent for one.
            const renamed = await guard(() => api.patch(`/api/roles/${role.id}`, {
              name: Object.keys(name).length === 0 ? null : name,
            }));
            if (!renamed) return;
            if (!locked) {
              const saved = await guard(() =>
                api.put(`/api/roles/${role.id}/permissions`, { permissions }));
              if (!saved) return;
            }
          }

          dialog.close();
          toast(t('common.saved'), 'success');
          // Role names appear on every screen, so the session behind this one
          // has to hear about the change too.
          await refreshStatus();
          await renderUsers(container);
        },
      }, t('common.save')),
    ],
  });
}

/** The shipped label for a built-in role, ignoring any name the owner gave it. */
function shippedRoleLabel(key) {
  const label = t(`users.role.${key.toLowerCase()}`);
  return label.startsWith('users.role.') ? key : label;
}

/**
 * A role the restaurant invents still needs a stable machine key, and asking an
 * owner to invent one is asking the wrong person. Derived from the name they
 * typed, falling back to ROLE_2, ROLE_3… when the name is in a script that has
 * no ASCII to derive from.
 */
function newRoleKey(name, taken) {
  const source = name.en ?? Object.values(name)[0] ?? '';
  const base = source.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  let candidate = /^[A-Z][A-Z0-9_]*$/.test(base) ? base : 'ROLE';
  let suffix = 2;
  while (taken.includes(candidate)) candidate = `${candidate.replace(/_\d+$/, '')}_${suffix++}`;
  return candidate;
}

/* -------------------------------------------------------------- printing */

export async function renderPrinting(container) {
  if (!can(Capability.PRINTING_RUNTIME)) {
    mount(container, pageHeader(t('printing.title')), lockedPanel(Capability.PRINTING_RUNTIME));
    return;
  }

  const [config, jobs] = await Promise.all([
    api.get('/api/printers'),
    api.get('/api/print-jobs').catch(() => ({ jobs: [] })),
  ]);

  mount(container,
    pageHeader(t('printing.title'),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        onClick: () => openPrinterForm(container, null, config),
      }, t('printing.add_printer'))),

    h('p', { class: 'qs-muted' },
      // Routing is configuration, which is the whole point of §36.
      `${t('printing.doc.kitchen_ticket')} → ${roleLabel('KITCHEN')} · ${t('printing.doc.receipt')} → ${roleLabel('CASHIER')}`),

    // "Nothing here yet" in a card the height of a hand is a hole in the page.
    // A restaurant with no printer is a supported restaurant, so this says so.
    config.printers.length === 0
      ? h('div', { class: 'qs-card qs-narrow' },
          h('p', { class: 'qs-muted qs-small', style: { margin: 0 } }, t('printing.no_printers')))
      : h('div', { class: 'qs-grid qs-grid-2' }, config.printers.map((printer) =>
          h('div', { class: 'qs-card' },
            h('div', { class: 'qs-card-head' },
              h('h3', { style: { margin: 0 } }, printer.name),
              h('span', { class: `qs-badge ${printer.enabled ? 'qs-badge-success' : ''}` },
                printer.enabled ? t('common.enabled') : t('common.disabled'))),
            h('p', { class: 'qs-small' }, te('printing.transport', printer.transport)),
            h('p', { class: 'qs-mono qs-xs' }, printer.target),
            h('p', { class: 'qs-small qs-muted' },
              printer.documentTypes.map((doc) => te('printing.doc', doc)).join(', '),
              printer.stations.length > 0 ? ` · ${printer.stations.join(', ')}` : ` · ${t('common.all')}`),
            h('button', {
              class: 'qs-btn qs-btn-ghost',
              onClick: () => openPrinterForm(container, printer, config),
            }, t('common.edit'))))),

    h('div', { class: 'qs-card qs-narrow', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
      h('h2', {}, t('printing.jobs')),
      jobs.jobs.length === 0
        ? h('p', { class: 'qs-muted qs-small' }, t('common.empty'))
        : h('div', { class: 'qs-table-wrap' },
            h('table', { class: 'qs-table' },
              h('tbody', {}, jobs.jobs.slice(0, 30).map((job) =>
                h('tr', {},
                  h('td', { class: 'qs-xs qs-muted' }, formatDateTime(job.createdAt)),
                  h('td', {}, te('printing.doc', job.documentType)),
                  h('td', {},
                    h('span', {
                      class: `qs-badge ${job.status === 'FAILED' ? 'qs-badge-error' : job.status === 'SENT' ? 'qs-badge-success' : ''}`,
                    }, job.status)),
                  h('td', { class: 'qs-xs qs-muted' }, job.lastError ?? ''),
                  h('td', {},
                    job.status === 'FAILED'
                      ? h('button', {
                          class: 'qs-btn qs-btn-ghost',
                          onClick: async () => {
                            await guard(() => api.post(`/api/print-jobs/${job.id}/retry`));
                            await renderPrinting(container);
                          },
                        }, t('common.retry'))
                      : null))))))));
}

function openPrinterForm(container, printer, config) {
  const form = h('form', {},
    h('label', { class: 'qs-field' },
      h('span', {}, t('common.name')),
      h('input', { name: 'name', required: true, value: printer?.name ?? '' })),
    h('label', { class: 'qs-field' },
      h('span', {}, t('printing.transport')),
      h('select', { name: 'transport' }, Object.values(PrinterTransport).map((transport) =>
        h('option', { value: transport, selected: transport === printer?.transport },
          te('printing.transport', transport))))),
    h('label', { class: 'qs-field' },
      h('span', {}, t('printing.target')),
      h('input', {
        name: 'target', required: true, value: printer?.target ?? '',
        placeholder: '192.168.1.50:9100',
      })),
    h('div', { class: 'qs-field' },
      h('span', {}, t('printing.documents')),
      Object.values(PrintDocumentType).map((doc) =>
        h('label', { class: 'qs-check' },
          h('input', {
            type: 'checkbox', name: `doc.${doc}`,
            checked: printer?.documentTypes.includes(doc) ?? doc === PrintDocumentType.KITCHEN_TICKET,
          }),
          h('span', {}, te('printing.doc', doc))))),
    h('div', { class: 'qs-field' },
      h('span', {}, `${t('printing.stations')} (${t('common.all')} = ${t('common.none')})`),
      (config.stations ?? []).length === 0
        ? h('p', { class: 'qs-xs qs-muted' }, t('common.empty'))
        : config.stations.map((station) =>
            h('label', { class: 'qs-check' },
              h('input', {
                type: 'checkbox', name: `station.${station}`,
                checked: printer?.stations.includes(station) ?? false,
              }),
              h('span', {}, station)))),
    h('label', { class: 'qs-field' },
      h('span', {}, t('printing.width')),
      h('input', { name: 'width', type: 'number', min: '24', max: '96', value: String(printer?.charactersPerLine ?? 42) })),
    h('label', { class: 'qs-check' },
      h('input', { type: 'checkbox', name: 'enabled', checked: printer ? printer.enabled : true }),
      h('span', {}, t('common.enabled'))));

  const dialog = modal({
    title: printer ? printer.name : t('printing.add_printer'),
    body: form,
    actions: [
      printer
        ? h('button', {
            class: 'qs-btn qs-btn-danger', value: 'delete', type: 'button',
            onClick: async () => {
              const ok = await confirmDialog({
                title: t('common.delete'), message: printer.name,
                confirmLabel: t('common.delete'), cancelLabel: t('common.cancel'),
              });
              if (!ok) return;
              await guard(() => api.del(`/api/printers/${printer.id}`));
              dialog.close();
              await renderPrinting(container);
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
            name: String(data.name).trim(),
            transport: data.transport,
            target: String(data.target).trim(),
            documentTypes: Object.values(PrintDocumentType).filter((doc) => data[`doc.${doc}`] === 'on'),
            stations: (config.stations ?? []).filter((station) => data[`station.${station}`] === 'on'),
            charactersPerLine: Number(data.width),
            enabled: data.enabled === 'on',
          };
          const saved = await guard(() => printer
            ? api.patch(`/api/printers/${printer.id}`, payload)
            : api.post('/api/printers', payload));
          if (!saved) return;
          dialog.close();
          await renderPrinting(container);
        },
      }, t('common.save')),
    ],
  });
}

/* ---------------------------------------------------------------- backup */

export async function renderBackup(container) {
  const { backups } = await api.get('/api/backups');

  const createForm = h('form', { class: 'qs-card' },
    h('h2', {}, t('backup.create')),
    h('p', { class: 'qs-muted' }, t('backup.passphrase_hint')),
    h('label', { class: 'qs-field' },
      h('span', {}, t('backup.passphrase')),
      h('input', { name: 'passphrase', type: 'password', minlength: '8', required: true })),
    h('label', { class: 'qs-field' },
      h('span', {}, t('backup.note')),
      h('input', { name: 'note', maxlength: '300' })),
    h('button', { class: 'qs-btn qs-btn-primary', type: 'submit' }, t('backup.create')));

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(createForm).entries());
    const created = await guard(() => api.post('/api/backups', {
      passphrase: String(data.passphrase),
      note: String(data.note ?? '').trim() || null,
    }));
    if (!created) return;
    toast(created.fileName, 'success');
    await renderBackup(container);
  });

  mount(container,
    pageHeader(t('backup.title')),
    h('div', { class: 'qs-grid qs-grid-2' }, createForm, restorePanel(container)),

    h('div', { class: 'qs-card', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
      h('h3', {}, t('backup.on_this_computer')),
      backups.length === 0
        ? h('p', { class: 'qs-muted qs-small' }, t('common.empty'))
        : h('div', { class: 'qs-table-wrap' },
            h('table', { class: 'qs-table' },
              h('thead', {}, h('tr', {},
                h('th', {}, t('common.created')),
                h('th', {}, t('common.name')),
                h('th', {}, t('common.size')),
                h('th', {}, t('backup.note')),
                h('th', {}, ''))),
              h('tbody', {}, backups.map((backup) =>
                h('tr', {},
                  h('td', { class: 'qs-small qs-muted' }, formatDateTime(backup.createdAt)),
                  h('td', { class: 'qs-mono qs-xs' }, backup.fileName),
                  h('td', {}, `${Math.round(backup.sizeBytes / 1024)} KB`),
                  h('td', { class: 'qs-small' }, backup.note ?? ''),
                  h('td', {},
                    h('a', {
                      class: 'qs-btn qs-btn-ghost',
                      href: `/api/backups/${backup.fileName}/download`,
                      download: '',
                    }, t('common.download'))))))))));
}

/**
 * Restore. Two deliberate frictions, because this replaces everything: the file
 * is inspected first (which needs no passphrase), and the operator must retype
 * the Restaurant ID the backup actually contains.
 */
function restorePanel(container) {
  let file = null;
  let header = null;
  const info = h('div', { class: 'qs-small qs-muted' }, '');

  const form = h('form', { class: 'qs-card' },
    h('h2', {}, t('backup.restore')),
    h('p', { class: 'qs-muted' }, t('backup.restore_warning')),

    h('label', { class: 'qs-field' },
      h('span', {}, t('backup.inspect')),
      h('input', {
        type: 'file', accept: '.qsbk',
        onChange: async (event) => {
          const picked = event.target.files?.[0];
          if (!picked) return;
          file = await picked.arrayBuffer();
          header = await guard(() =>
            api.upload('/api/backups/inspect', file, 'application/octet-stream'));
          mount(info, header
            ? h('div', {},
                h('div', {}, `${t('license.restaurant_id')}: `, h('strong', {}, header.restaurantId)),
                h('div', {}, `${t('common.created')}: ${formatDateTime(header.createdAt)}`),
                h('div', {}, `${t('app.name')} ${header.appVersion}`),
                header.note ? h('div', {}, header.note) : null)
            : h('span', {}, t('error.conflict')));
        },
      })),
    info,

    h('label', { class: 'qs-field' },
      h('span', {}, t('backup.passphrase')),
      h('input', { name: 'passphrase', type: 'password', required: true })),
    h('label', { class: 'qs-field' },
      h('span', {}, t('backup.confirm_restaurant')),
      h('input', { name: 'confirm', required: true, placeholder: 'REST-000000' })),
    h('button', { class: 'qs-btn qs-btn-danger', type: 'submit' }, t('backup.restore')));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!file || !header) {
      toast(t('error.validation'), 'error');
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());

    const ok = await confirmDialog({
      title: t('backup.restore'),
      message: t('backup.restore_warning'),
      confirmLabel: t('backup.restore'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;

    const query = new URLSearchParams({
      passphrase: String(data.passphrase),
      confirmRestaurantId: String(data.confirm).trim(),
    });
    const result = await guard(() =>
      api.upload(`/api/backups/restore?${query}`, file, 'application/octet-stream'));
    if (!result) return;

    // A restore replaces the user table, so every session is gone — including
    // this one. Reloading lands on the sign-in screen, which is correct.
    toast(`${result.rows} rows`, 'success');
    setTimeout(() => location.reload(), 1200);
  });

  return form;
}

/* --------------------------------------------------------------- licence */

export async function renderLicense(container) {
  const [status, vendor] = await Promise.all([
    api.get('/api/license'),
    api.get('/api/license/vendor').catch(() => null),
  ]);

  // What activation unlocks, in words rather than identifiers: this list is the
  // honest answer to "what am I paying for", so it has to be readable.
  const capabilityLabel = (capability) => {
    const label = t(`capability.${capability}`);
    return label.startsWith('capability.') ? capability : label;
  };

  const capabilityRow = (capability, unlocked) =>
    h('div', { class: 'capability', 'data-unlocked': String(unlocked) },
      h('span', {}, unlocked ? '✓' : '🔒'),
      h('span', {}, capabilityLabel(capability)));

  const activateForm = h('form', {},
    h('label', { class: 'qs-field' },
      h('span', {}, t('license.key')),
      h('input', {
        name: 'licenseKey', class: 'license-key-input', required: true,
        placeholder: 'QSRV-XXXXX-XXXXX-XXXXX-XXXXX',
        autocomplete: 'off', spellcheck: 'false',
      })),
    h('label', { class: 'qs-check' },
      h('input', { type: 'checkbox', name: 'remember', checked: true }),
      h('span', {}, t('license.remember_key'))),
    h('button', { class: 'qs-btn qs-btn-primary qs-btn-lg', type: 'submit' }, t('license.activate')));

  activateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(activateForm).entries());
    const result = await guard(() => api.post('/api/license/activate', {
      licenseKey: String(data.licenseKey).trim(),
      rememberKey: data.remember === 'on',
    }));
    if (!result) return;
    toast(t('license.state.active'), 'success');
    await refreshStatus();
    navigate('dashboard');
  });

  mount(container,
    pageHeader(t('license.title')),

    // In SETUP the licence panel is the thing waiting on a person, so it is
    // what carries the travelling light. Once activated it stops — nothing on
    // an activated console is asking for anything.
    h('div', { class: `license-hero qs-narrow${isSetup() ? ' qs-lit' : ''}` },
      h('div', { class: 'qs-row qs-row-between' },
        h('h2', { style: { margin: 0 } }, t(status.explanation)),
        h('span', { class: 'mode-badge', 'data-mode': status.mode },
          te('license.mode', status.mode))),

      h('div', { class: 'qs-grid qs-grid-2' },
        h('div', {},
          h('div', { class: 'qs-section-title' }, t('license.device')),
          h('p', { class: 'qs-small' }, status.deviceLabel),
          h('p', { class: 'qs-mono qs-xs' }, status.deviceFingerprint)),
        h('div', {},
          h('div', { class: 'qs-section-title' }, t('license.title')),
          h('p', { class: 'qs-small' },
            `${t('license.restaurant_id')}: `, h('span', { class: 'qs-mono' }, state.status.restaurantId ?? '—')),
          status.licenseId
            ? h('p', { class: 'qs-small' },
                `${t('license.license_id')}: `, h('span', { class: 'qs-mono' }, status.licenseId))
            : null,
          h('p', { class: 'qs-small' },
            `${t('license.type_perpetual')} · ${t('license.transfers')}: ${status.transferCount}`),
          status.activatedAt
            ? h('p', { class: 'qs-small qs-muted' },
                `${t('license.activated_at')}: ${formatDateTime(status.activatedAt)}`)
            : null))),

    isSetup()
      ? h('div', { class: 'qs-grid qs-grid-2', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
          h('div', { class: 'qs-card' },
            h('h2', {}, t('license.have_key')),
            activateForm),
          vendorPanel(vendor, container))
      // Once licensed there is one thing left to do here and it is rare, so it
      // is a line at the end rather than a card beside a card — a half-empty
      // panel holding one button was the emptiest space on the console.
      : h('div', { style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
          vendorPanel(vendor, container),
          h('div', {
            class: 'qs-card qs-narrow',
            style: { marginBlockStart: 'var(--qs-spacing-lg)' },
          },
            h('div', { class: 'qs-row-item' },
              h('div', {},
                h('div', { class: 'qs-row-label' }, t('license.deactivate')),
                h('p', { class: 'qs-row-hint' }, t('license.deactivate_hint'))),
              h('div', { class: 'qs-row-control' },
                h('button', {
                  class: 'qs-btn qs-btn-danger',
                  onClick: async () => {
                    const ok = await confirmDialog({
                      title: t('license.deactivate'),
                      message: t('license.deactivate_hint'),
                      confirmLabel: t('license.deactivate'),
                      cancelLabel: t('common.cancel'),
                    });
                    if (!ok) return;
                    const done = await guard(() => api.post('/api/license/deactivate', {
                      reason: 'moving to another computer',
                    }));
                    if (!done) return;
                    await refreshStatus();
                    await renderLicense(container);
                  },
                }, t('license.deactivate')))))),

    h('div', { class: 'qs-card qs-narrow', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
      h('h2', {}, isSetup() ? t('license.locked_features') : t('common.enabled')),
      // Thirteen lines of reference: worth having, not worth reading every
      // time somebody opens this screen to check whether they are licensed.
      h('details', { class: 'qs-details' },
        h('summary', {},
          t('license.capabilities_summary', {
            unlocked: status.capabilities.length,
            of: Object.values(Capability).length,
          })),
        h('div', { class: 'capability-list' },
          Object.values(Capability).map((capability) =>
            capabilityRow(capability, status.capabilities.includes(capability)))))));
}

/**
 * Who to contact for a licence, and what the vendor charges.
 *
 * QServe handles no money. Everything on this panel is text the vendor wrote in
 * their own console and this computer cached, so the prices shown are theirs
 * and can change without a new version of the application.
 */
function vendorPanel(vendor, container) {
  const info = vendor?.info ?? null;
  const message = vendor
    ? t('license.request_body', {
        restaurant: vendor.request.restaurantName || '—',
        restaurantId: vendor.request.restaurantId ?? '—',
        version: vendor.request.appVersion,
        device: vendor.request.deviceLabel,
      })
    : '';

  // What it costs, on the same kind of line as everything else the console
  // lists: the thing on the left, its sentence under it, the number on the
  // right. Two filled blocks made a price list look like a warning.
  const priceRow = (labelKey, price) =>
    h('div', { class: 'qs-row-item' },
      h('div', {},
        h('div', { class: 'qs-row-label' }, t(labelKey)),
        price?.note ? h('p', { class: 'qs-row-hint' }, price.note) : null),
      h('div', { class: 'qs-row-control' },
        h('strong', {}, price?.price || t('license.price_ask'))));

  const contactLink = (contact) => {
    const label = contact.label || t(`license.contact_${contact.kind.toLowerCase()}`);
    // WhatsApp and Telegram take a prefilled message; the rest are plain links.
    const href = contact.url && (contact.kind === 'WHATSAPP' || contact.kind === 'TELEGRAM')
      ? `${contact.url}?text=${encodeURIComponent(message)}`
      : contact.url;

    return href
      ? h('a', { class: 'qs-btn', href, target: '_blank', rel: 'noopener' },
          `${label} · ${contact.value}`)
      : h('span', { class: 'qs-badge' }, `${label} · ${contact.value}`);
  };

  return h('div', { class: 'qs-card qs-narrow' },
    h('h2', {}, t('license.request')),
    h('p', { class: 'qs-muted qs-small' }, t('license.no_payment')),

    info?.vendorName
      ? h('p', {}, h('strong', {}, info.vendorName),
          info.tagline ? h('span', { class: 'qs-muted qs-small' }, ` — ${info.tagline}`) : null)
      : null,

    h('div', { class: 'qs-rows' },
      priceRow('license.price_activation', info?.pricing?.activation),
      priceRow('license.price_transfer', info?.pricing?.transfer)),

    info?.instructions
      ? h('p', { class: 'qs-small', style: { whiteSpace: 'pre-wrap' } }, info.instructions)
      : null,

    (info?.contacts ?? []).length > 0
      ? h('div', { class: 'qs-row', style: { flexWrap: 'wrap' } },
          vendor.contacts.map(contactLink))
      : null,

    // The message a restaurant sends, ready to copy — kept closed, because the
    // contact buttons already carry it and an owner who taps one never needs to
    // read it. Loose on the card it looked like something had gone wrong.
    message
      ? h('details', { class: 'qs-details' },
          h('summary', {}, t('license.message_preview')),
          h('pre', { class: 'qs-xs qs-muted', style: { whiteSpace: 'pre-wrap' } }, message))
      : null,

    h('div', { class: 'qs-row', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
      h('button', {
        class: 'qs-btn qs-btn-ghost qs-btn-sm',
        onClick: async () => {
          const done = await guard(() => api.post('/api/license/vendor/refresh'));
          if (!done) return;
          await renderLicense(container);
        },
      }, t('license.refresh_vendor')),

      // One line about where these prices came from, never two. "Shipped" is
      // worth saying: it is why a restaurant with no internet still sees a
      // phone number, and why that number may be older than the vendor's.
      h('span', { class: 'qs-xs qs-muted' },
        vendor?.fetchedAt
          ? (vendor.stale
              ? t('license.vendor_stale', { when: formatDateTime(vendor.fetchedAt) })
              : formatDateTime(vendor.fetchedAt))
          : vendor?.source === 'shipped'
            ? t('license.source_shipped')
            : t('license.vendor_never'))));
}
