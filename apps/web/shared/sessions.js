/**
 * One account, one place at a time.
 *
 * Signing in somewhere while the same account is signed in elsewhere does not
 * take the session and does not simply fail. It asks: the device that has the
 * account is shown who is asking and from where, told plainly that saying yes
 * signs it out, and given a minute to answer. Silence is a no.
 *
 * The reason is the audit trail. Every action in this product records who did
 * it, and that record only means something while "who" is one person. A
 * cashier's account open at the counter and in the back office turns the log
 * into a record of an account rather than of a person, which is worth much less
 * on the day somebody needs to read it.
 *
 * Two halves live here: the waiting half, used by whichever screen is signing
 * in, and the answering half, wired up by `boot()` on every screen that is
 * already signed in.
 */

import { api } from './api.js';
import { t } from './i18n.js';
import { h, modal, toast } from './dom.js';
import { EventName } from './events.js';

/* ------------------------------------------------------------- the newcomer */

/**
 * Sign in, waiting for the other device if there is one.
 *
 * Resolves when the account is this device's, throws if it is refused. The
 * dialog it puts up while waiting is cancellable, because the person at the
 * other end may simply not be there and standing at a spinner for a minute
 * with no way out is its own kind of failure.
 */
export async function signIn({ username, password }) {
  const answer = await api.raw('POST', '/api/auth/login', { username, password });

  // A session straight away: nobody else had the account.
  if (!answer?.pending) return answer;

  return waitForApproval(answer.requestId, {
    username,
    seconds: answer.expiresInSeconds ?? 60,
  });
}

function waitForApproval(requestId, { username, seconds }) {
  return new Promise((resolve, reject) => {
    let stopped = false;

    const dialog = modal({
      title: t('session.waiting_title'),
      body: h('div', {},
        h('p', {}, t('session.waiting_body', { username })),
        h('p', { class: 'qs-muted qs-small' }, t('session.waiting_hint'))),
      actions: [h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel'))],
      onClose: () => {
        if (stopped) return;
        stopped = true;
        reject(new Error('cancelled'));
      },
    });

    const finish = (fn) => {
      if (stopped) return;
      stopped = true;
      dialog.close();
      fn();
    };

    const deadline = Date.now() + seconds * 1000 + 5_000;

    const poll = async () => {
      if (stopped) return;
      if (Date.now() > deadline) {
        finish(() => reject(new Error(t('session.no_answer'))));
        return;
      }
      try {
        const state = await api.get(`/api/auth/login/${encodeURIComponent(requestId)}`);
        if (state.state === 'approved') {
          finish(() => resolve(state));
          return;
        }
        if (state.state === 'denied' || state.state === 'expired') {
          finish(() => reject(new Error(t(
            state.state === 'denied' ? 'session.refused' : 'session.no_answer'))));
          return;
        }
      } catch {
        // A blip on the way to a server that is right there: keep asking. The
        // deadline above is what ends this, not one failed request.
      }
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 1200);
  });
}

/* ------------------------------------------------------------ the incumbent */

/** Requests already answered on this screen, so a replay does not ask twice. */
const answered = new Set();

/**
 * Watch for somebody asking for this account, and for this session ending.
 *
 * Called once by `boot()`. The question arrives as an event for a screen that
 * is open, and in `/api/auth/me` for one that was not — a tablet woken from
 * sleep mid-question would otherwise never be asked at all.
 */
export function watchSessions({ realtime, session }) {
  const me = session.user?.id;
  if (!me) return;

  for (const request of session.pendingLogins ?? []) ask(request);

  realtime.on(EventName.SYSTEM_LOGIN_REQUESTED, (payload) => {
    if (payload?.userId !== me) return;
    ask(payload.request);
  });

  realtime.on(EventName.SYSTEM_SESSION_ENDED, (payload) => {
    if (payload?.userId !== me) return;
    // Told why, then out. Reloading lands on the sign-in screen, which is
    // where somebody who has just been signed out should be.
    endedElsewhere();
  });
}

/** The question currently on this screen, so a newer one can replace it. */
let showing = null;

async function ask(request) {
  if (!request || answered.has(request.id)) return;
  answered.add(request.id);

  /*
   * A newer attempt replaces the older one on the server, which means an
   * older question on this screen is already dead. Take it down rather than
   * leave somebody deciding something their answer can no longer affect.
   */
  if (showing) {
    const stale = showing;
    showing = null;
    stale.settle(null);
  }

  const from = request.fromTerminalName || request.fromIp;
  const seconds = Math.max(0, Math.round(request.expiresInSeconds ?? 60));

  const answer = await new Promise((resolve) => {
    let done = false;
    let ticking = null;

    /*
     * The buttons answer directly rather than through the dialog's `close`
     * event.
     *
     * Closing a `<dialog>` by submitting its form is supposed to fire `close`,
     * and usually does — but a browser that misses it would leave this screen
     * looking like it had answered while the other device waited out the full
     * minute and was told "no answer". The button press is the decision; the
     * dialog closing is only what it looks like.
     */
    const settle = (value) => {
      if (done) return;
      done = true;
      clearInterval(ticking);
      if (showing?.dialog === dialog) showing = null;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };

    const countdown = h('p', { class: 'qs-muted qs-small' },
      t('session.request_countdown', { seconds }));

    const dialog = modal({
      title: t('session.request_title'),
      body: h('div', {},
        h('p', {}, t('session.request_body', { from })),
        countdown),
      actions: [
        h('button', {
          class: 'qs-btn',
          value: 'cancel',
          onClick: () => settle(false),
        }, t('session.keep_me_in')),
        h('button', {
          class: 'qs-btn qs-btn-danger',
          value: 'confirm',
          onClick: () => settle(true),
        }, t('session.let_them_in')),
      ],
      // Escape, or the × in the corner: a question dismissed is a question
      // declined, which is the same answer silence would have given.
      onClose: () => settle(false),
    });

    // The window is a minute, and a dialog that simply vanished would look
    // like a fault. It counts down instead, and takes itself away when the
    // answer would no longer be accepted.
    let left = seconds;
    ticking = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        settle(null);
        return;
      }
      countdown.textContent = t('session.request_countdown', { seconds: left });
    }, 1000);

    showing = { id: request.id, dialog, settle };
  });

  // Nothing to send for a question this screen took down itself — superseded
  // by a newer one, or run out of time. The server has already moved on.
  if (answer === null) return;

  await api.post(`/api/auth/login-requests/${encodeURIComponent(request.id)}`,
    { approve: answer }).catch(() => {});

  // Nothing else to do on a yes: the server ends this session when the other
  // device claims the approval, and the event that follows shows the notice.
  if (!answer) toast(t('session.kept'), 'info');
}

function endedElsewhere() {
  // The button reloads, and so does closing the notice by any other means.
  // Whichever way this is dismissed, the screen behind it belongs to a session
  // that no longer exists and must not be left standing.
  modal({
    title: t('session.ended_title'),
    body: h('p', {}, t('session.ended_body')),
    actions: [h('button', {
      class: 'qs-btn qs-btn-primary',
      value: 'ok',
      onClick: () => location.reload(),
    }, t('common.signin'))],
    onClose: () => location.reload(),
  });
}
