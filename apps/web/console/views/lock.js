/**
 * The lock screen.
 *
 * Shown before anything else when the owner has chosen to lock this computer.
 * It is not a hidden page: while it is up the server refuses every console
 * route except this one, so there is nothing behind it to reach.
 *
 * It draws itself from a single reply — the restaurant's name, its language and
 * its theme come with the lock status — because `/api/system` is one of the
 * routes locked away, and a lock screen in the wrong language would be a poor
 * first impression of a system that speaks the owner's.
 */

import { api, t } from '../../shared/boot.js';
import { h, mount, toast } from '../../shared/dom.js';
import { loadLocales, setLocale, preferredLocale, pick } from '../../shared/i18n.js';
import { applyTheme } from '../../shared/theme.js';

export async function renderLockScreen(root, lock) {
  // Best effort: if the language pack cannot be fetched the screen still works,
  // it just falls back to keys — better than refusing to let anyone in.
  await loadLocales().catch(() => {});
  await setLocale(preferredLocale(lock.locale ?? 'en'), { remember: false }).catch(() => {});
  await applyTheme(lock.themeId ?? 'light').catch(() => {});

  const input = h('input', {
    name: 'passphrase',
    type: 'password',
    required: true,
    autofocus: true,
    autocomplete: 'current-password',
    'aria-label': t('lock.password'),
  });

  const form = h('form', { class: 'qs-card lock-card' });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.post('/api/lock/unlock', { passphrase: input.value });
      location.reload();
    } catch (error) {
      // Deliberately the same message for a wrong password and a rate limit
      // hit; the details are in the activity log, not on the lock screen.
      toast(t(error.code === 'RATE_LIMITED' ? 'error.rate_limited' : 'lock.wrong_password'), 'error');
      input.value = '';
      input.focus();
    }
  });

  mount(form,
    h('div', { class: 'lock-mark' }, '🔒'),
    h('h1', {}, pick(lock.restaurantName) || t('app.name')),
    h('p', { class: 'qs-muted' }, t('lock.locked')),

    h('label', { class: 'qs-field' },
      h('span', {}, t('lock.password')),
      input),

    lock.hint ? h('p', { class: 'qs-xs qs-muted' }, `${t('lock.hint')}: ${lock.hint}`) : null,

    h('button', { class: 'qs-btn qs-btn-primary qs-btn-block qs-btn-lg', type: 'submit' },
      t('lock.unlock')),

    h('p', { class: 'qs-xs qs-muted', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
      t('lock.terminals_unaffected')));

  mount(root, h('div', { class: 'lock-screen' }, form));
  input.focus();
}
