/**
 * The link to the restaurant, and what a screen does when it breaks.
 *
 * Every terminal in this product is a window onto one computer in the back
 * office. When that computer stops answering — it was shut down, the router
 * rebooted, a tablet wandered out of range — the window does not stop looking
 * like a working till. Buttons still press, a kitchen queue still lists the
 * orders it had ten minutes ago, and somebody carries on working against a
 * screen that is no longer connected to anything. That is the failure that
 * actually costs a restaurant money, and it is silent.
 *
 * So the two kinds of screen are treated differently, because the right answer
 * genuinely differs:
 *
 *   Staff screens are taken over and signed out. A till whose server is gone
 *   can do nothing useful and can be trusted with nothing; leaving it signed in
 *   means an unattended terminal in a room full of people. The takeover is
 *   final — the way back is a fresh sign-in, which is also what the server will
 *   demand, since it ends every staff session when it starts.
 *
 *   The diner's menu is left alone. A guest halfway through reading the menu
 *   has done nothing wrong and should not be thrown out of it; the menu is
 *   already on their phone. What stops is ordering, and it says so plainly
 *   rather than failing with a spinner.
 *
 * Both wait before acting. A tablet that dips out of Wi-Fi for two seconds is
 * not an outage, and a screen that threw the cashier out every time a packet
 * went missing would be worse than the problem it solves.
 */

import { api } from './api.js';
import { t } from './i18n.js';
import { h } from './dom.js';

/** How long the restaurant must stay unreachable before a screen acts on it. */
const STAFF_GRACE_MS = 25_000;
/** Shorter for the diner: nothing is destroyed, and silence is confusing. */
const DINER_GRACE_MS = 8_000;
/** How often a taken-over screen looks to see whether the restaurant is back. */
const PROBE_MS = 3_000;

let down = false;
const listeners = new Set();

/** Is the restaurant currently out of reach? */
export function linkIsDown() {
  return down;
}

/** Called now and on every change, so a view can render the truth immediately. */
export function onLinkChange(listener) {
  listeners.add(listener);
  listener(down);
  return () => listeners.delete(listener);
}

function setDown(value) {
  if (down === value) return;
  down = value;
  // A data attribute as well as an event: stylesheets can dim a screen that has
  // lost its restaurant without every app writing the same class logic.
  document.documentElement.dataset.link = value ? 'down' : 'up';
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      console.error('[link] listener failed', error);
    }
  }
}

/**
 * Watch the socket and act when it stays down.
 *
 * `mode` is 'staff' or 'diner'. A screen with nobody signed in — the console
 * during first-run setup — is watched but never taken over: there is no session
 * to end, and a setup wizard interrupted by a takeover would simply be lost.
 */
export function watchLink({ realtime, mode = 'staff', signedIn = true }) {
  const grace = mode === 'diner' ? DINER_GRACE_MS : STAFF_GRACE_MS;
  let timer = null;
  let takenOver = false;

  realtime.onStateChange((state) => {
    if (takenOver) return;

    if (state === 'open') {
      clearTimeout(timer);
      timer = null;
      setDown(false);
      return;
    }

    // 'connecting' on a screen that has never been connected is start-up, not
    // an outage; the boot call has already proven the server was there.
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      setDown(true);
      if (mode !== 'diner' && signedIn) {
        takenOver = true;
        takeOver();
      }
    }, grace);
  });
}

/* --------------------------------------------------------- the takeover */

/**
 * End the session and hold the screen.
 *
 * Deliberately not a dialog. A dialog can be dismissed, and what is behind it
 * would still be a till: this replaces the screen, and the only control on it
 * is the one that starts again.
 */
function takeOver() {
  const status = h('p', { class: 'qs-link-status' }, t('link.searching'));
  const again = h('button', {
    class: 'qs-btn qs-btn-primary',
    disabled: true,
    onClick: () => location.reload(),
  }, t('link.sign_in_again'));

  const screen = h('div', { class: 'qs-link-lost', role: 'alertdialog', 'aria-live': 'assertive' },
    h('div', { class: 'qs-link-card' },
      h('div', { class: 'qs-link-mark', 'aria-hidden': 'true' },
        h('span', { class: 'qs-link-pulse' }, '')),
      h('h1', {}, t('link.lost_title')),
      h('p', { class: 'qs-muted' }, t('link.lost_body')),
      status,
      again));

  document.body.append(screen);

  /*
   * Keep looking. The session is ended the moment the restaurant answers
   * again rather than now, because now there is nobody to tell: the cookie
   * this device holds can only be revoked by the machine that issued it.
   */
  const probe = setInterval(async () => {
    const alive = await api.get('/api/auth/me').then(() => true).catch(() => false);
    if (!alive) return;

    clearInterval(probe);
    await api.post('/api/auth/logout').catch(() => {});
    setDown(false);
    status.textContent = t('link.found');
    again.disabled = false;
    // Nobody may be standing in front of a kitchen screen to press it.
    setTimeout(() => location.reload(), 4000);
  }, PROBE_MS);
}

/* ------------------------------------------------------------ the diner */

/**
 * The strip a diner sees while the restaurant is unreachable.
 *
 * It says what stopped and what still works, which is the whole difference
 * between "this place is broken" and "the menu is still here".
 */
export function offlineNotice() {
  // Built from the state as it is now, not wired to it: the diner's menu
  // repaints on every change anyway, and a strip that subscribed would leave a
  // listener behind on each repaint.
  return h('div', { class: 'qs-menu-offline', hidden: !down },
    h('strong', {}, t('menu.offline_title')),
    h('span', {}, t('menu.offline_body')));
}
