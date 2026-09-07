/**
 * Common start-up for every terminal.
 *
 * Each app calls `boot()` once. It resolves the session, loads the language
 * pack and theme the restaurant chose, wires the sound profile the *terminal*
 * was configured with, and opens the realtime socket. By the time an app's own
 * `render()` runs, everything it needs is present and localised.
 */

import { api, ApiError } from './api.js';
import { loadLocales, setLocale, preferredLocale, t, describeError } from './i18n.js';
import { applyTheme } from './theme.js';
import { sound } from './sound.js';
import { Realtime } from './realtime.js';
import { NotificationCentre } from './notifications.js';
import { setRoleNames } from './roles.js';
import { EventName } from './events.js';
import { h, mount, toast } from './dom.js';

export { api, ApiError, t, describeError, sound, toast };
export { NotificationCentre };
export { roleLabel, stationLabel, isRenamed, setRoleNames } from './roles.js';

export async function boot({
  topics = null,
  onResync = null,
  requireTerminal = false,
  /** A terminal that wants to react to a notice itself, beyond the centre. */
  onNotification = null,
} = {}) {
  const session = await api.get('/api/auth/me').catch(() => null);

  if (!session) {
    renderFatal(
      'Cannot reach the restaurant server',
      'This device is not on the restaurant network, or the main computer is switched off.',
    );
    throw new Error('no session');
  }

  // A staff screen reached without scanning its QR: tell the person what to do
  // rather than showing an empty board they will assume is broken.
  if (requireTerminal && !session.terminal) {
    renderFatal(
      'Scan this station’s QR code',
      'Open the QServe console on the restaurant computer, find this station under Terminals, and scan its code with this device.',
    );
    throw new Error('no terminal session');
  }

  // The restaurant's own words for its people, before anything is drawn: the
  // heading of this very screen may be one of them.
  setRoleNames(session.roleNames);

  const restaurantLocale = session.locale ?? 'en';
  await loadLocales().catch(() => {});
  await setLocale(preferredLocale(restaurantLocale), { remember: false }).catch(async () => {
    await setLocale('en', { remember: false });
  });
  await applyTheme(session.themeId ?? 'light');

  if (session.terminal?.soundProfile) sound.setProfile(session.terminal.soundProfile);

  // Browsers block audio until a gesture; the first tap anywhere unlocks it.
  const unlock = () => {
    if (sound.unlock()) {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    }
  };
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);

  const realtime = new Realtime({ topics, onResync });
  // The console boots signed-out during first-run setup, and the server rightly
  // refuses an unauthenticated upgrade. Connecting anyway would just fill the
  // log with handshake failures, so wait until there is a session to present.
  const signedIn = Boolean(session.user || session.terminal);
  if (signedIn) realtime.connect();

  // Every station carries the same notification centre. What each one is told
  // is decided on the server, so a diner's phone simply receives nothing.
  const notifications = new NotificationCentre(realtime,
    onNotification ? { onArrive: onNotification } : {});
  if (signedIn) void notifications.refresh();

  // A role renamed in the console is a word on this screen's heading. Rather
  // than make every station wait for its next reload, take the new names as
  // they are published and re-render.
  realtime.on(EventName.SYSTEM_SETTINGS_CHANGED, (payload) => {
    if (!payload?.keys?.includes('roles')) return;
    void api.get('/api/auth/me').then((fresh) => {
      setRoleNames(fresh.roleNames);
      onResync?.();
    }).catch(() => {});
  });

  return { session, realtime, sound, notifications };
}

/** Connection indicator every staff screen puts in its header. */
export function connectionIndicator(realtime) {
  const node = h('span', { class: 'qs-connection', 'data-state': 'connecting' }, '');
  realtime.onStateChange((state) => {
    node.dataset.state = state;
    node.textContent = state === 'open' ? t('common.online') : t('app.offline');
  });
  return node;
}

/** Full-screen failure, used only when the app genuinely cannot start. */
export function renderFatal(title, message) {
  mount(document.body,
    h('div', { class: 'qs-page' },
      h('div', { class: 'qs-card qs-center', style: { maxWidth: '520px', marginInline: 'auto' } },
        h('h1', {}, title),
        h('p', { class: 'qs-muted' }, message),
        h('button', { class: 'qs-btn qs-btn-primary', onClick: () => location.reload() },
          'Try again'))));
}

/**
 * Run an action, showing a localised toast on failure. Every button in the
 * product goes through this, so no click can fail silently.
 */
export async function guard(action, { onLicenseRequired } = {}) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ApiError && error.isLicenseRequired && onLicenseRequired) {
      onLicenseRequired(error);
      return undefined;
    }
    toast(describeError(error), 'error');
    return undefined;
  }
}

/** Banner shown while the socket is down, so nobody trusts a stale screen. */
export function offlineBanner(realtime) {
  const node = h('div', { class: 'qs-offline-banner qs-hidden' }, '');
  realtime.onStateChange((state) => {
    const down = state === 'reconnecting' || state === 'closed';
    node.classList.toggle('qs-hidden', !down);
    node.textContent = t('app.offline');
  });
  return node;
}
