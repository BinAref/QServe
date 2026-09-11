/**
 * System status, first-run setup and staff authentication.
 *
 * The setup routes are the SETUP-mode entry point (spec §40): create the
 * restaurant, create the owner account, then build the real menu. None of them
 * needs a licence, and none of the data they write is thrown away at activation.
 */

import {
  asObject, conflict, DEFAULT_CURRENCY, EventName, LOCALE_CODE_PATTERN, notFound,
  optionalBoolean, optionalString, requireLocalised, requireString, SystemRole,
  unauthenticated, validationError,
} from '@qserve/shared';
import { HttpResponse, RateLimiter, Router } from '@qserve/http';
import type { Services } from '../../container.js';
import { systemStatus } from '../../container.js';
import {
  clearUserCookie, readUserToken, userCookie, type AppState,
} from '../../core/security.js';
import { AppError, ErrorCode } from '@qserve/shared';

/** Staff sign in with short PINs on shared tablets, so guessing must be capped. */
const loginLimiter = new RateLimiter({ windowMs: 10 * 60 * 1000, max: 12 });

export interface RouteDeps {
  readonly services: Services;
  readonly isLanRunning: () => boolean;
}

export function createSystemRoutes(deps: RouteDeps): Router<AppState> {
  const { services } = deps;
  const router = new Router<AppState>();
  const security = services.security;

  /* -------------------------------------------------------------- status */

  router.get('/system', () => systemStatus(services, deps.isLanRunning()));

  /* --------------------------------------------------------------- setup */

  /**
   * Create the restaurant. Available before any licence exists — this is the
   * whole point of SETUP mode. The Restaurant ID assigned here is provisional
   * and is replaced by the vendor-issued one at activation, with all data
   * carried across.
   */
  router.post('/setup/restaurant', (ctx) => {
    if (services.settings.profile()) {
      throw conflict('this installation already has a restaurant');
    }
    const body = asObject(ctx.body);

    const defaultLocale = optionalString(body, 'defaultLocale', {
      pattern: LOCALE_CODE_PATTERN, max: 12,
    }) ?? 'en';
    if (!services.translations.has(defaultLocale)) {
      throw validationError('that language is not installed', { field: 'defaultLocale' });
    }

    const themeId = optionalString(body, 'themeId', { max: 32 }) ?? 'light';
    if (!services.themes.has(themeId)) {
      throw validationError('that theme is not installed', { field: 'themeId' });
    }

    const profile = services.settings.createRestaurant({
      // Provisional until activation. The prefix makes it obvious in support
      // that this installation has not yet been issued a vendor identity.
      restaurantId: `SETUP-${Date.now().toString(36).toUpperCase()}`,
      name: requireLocalised(body, 'name', { max: 200 }),
      defaultLocale,
      enabledLocales: [defaultLocale],
      themeId,
      currency: DEFAULT_CURRENCY,
    });

    // The base currency is a row from the first moment, so the menu has
    // something to price against before anything is priced.
    services.currencies.seedBase(DEFAULT_CURRENCY);

    services.audit.record({
      action: 'restaurant.created',
      actor: { kind: 'SYSTEM', userId: null, userName: null, terminalId: null, terminalName: null },
      entityType: 'restaurant',
      entityId: profile.restaurant_id,
      clientIp: ctx.ip,
    });

    return services.settings.profile();
  }, [security.adminListenerOnly()]);

  /**
   * Create the owner account. Only possible while the installation has no
   * users at all, so this route cannot be used to add a second administrator.
   */
  router.post('/setup/owner', (ctx) => {
    if (services.access.countUsers() > 0) {
      throw conflict('an owner account already exists; sign in instead');
    }
    const body = asObject(ctx.body);

    const user = services.access.createUser({
      username: requireString(body, 'username', { min: 3, max: 40, pattern: /^[a-zA-Z0-9._-]+$/ }),
      displayName: requireString(body, 'displayName', { max: 80 }),
      secret: requireString(body, 'password', { min: 8, max: 200, trim: false }),
      roleKeys: [SystemRole.ADMIN],
    });

    services.audit.record({
      action: 'user.created',
      actor: { kind: 'SYSTEM', userId: null, userName: null, terminalId: null, terminalName: null },
      entityType: 'user',
      entityId: user.id,
      detail: { role: SystemRole.ADMIN, bootstrap: true },
      clientIp: ctx.ip,
    });

    return { id: user.id, username: user.username, displayName: user.display_name };
  }, [security.adminListenerOnly()]);

  /**
   * Where this restaurant's menu comes from.
   *
   * Asked once, on the first run, before anybody has typed anything: bring the
   * menu you already have, or start a new one. Only the second needs a route —
   * bringing one is a backup restore, which sets the same flag on its way
   * through — and all this records is that the question has been answered, so
   * it is never asked again.
   */
  router.post('/setup/menu', (ctx) => {
    if (services.settings.get<boolean>('setup.menuStarted') === true) {
      throw conflict('this restaurant has already started its menu');
    }
    services.settings.set('setup.menuStarted', true);

    services.audit.record({
      action: 'menu.started_fresh',
      actor: ctx.state.auth!.actor,
      entityType: 'restaurant',
      entityId: services.settings.profile()?.restaurantId ?? 'unknown',
      clientIp: ctx.ip,
    });

    return { menuStarted: true };
  }, [security.adminListenerOnly(), security.requireUser()]);

  /* ---------------------------------------------------------------- auth */

  router.post('/auth/login', (ctx) => {
    const body = asObject(ctx.body);
    const username = requireString(body, 'username', { max: 40 });
    const password = requireString(body, 'password', { min: 1, max: 200, trim: false });

    const verdict = loginLimiter.check(`${ctx.ip}:${username}`);
    if (!verdict.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, 'too many sign-in attempts', {
        status: 429,
        messageKey: 'error.rate_limited',
        details: { retryAfterSeconds: verdict.retryAfterSeconds },
      });
    }

    const user = services.access.getUserByUsername(username);
    const ok = user !== undefined
      && user.active === 1
      && services.access.verifyUserSecret(user, password);

    if (!user || !ok) {
      services.audit.record({
        action: 'user.login_failed',
        actor: { kind: 'SYSTEM', userId: null, userName: null, terminalId: null, terminalName: null },
        entityType: 'user',
        detail: { username },
        clientIp: ctx.ip,
      });
      throw unauthenticated('incorrect username or password');
    }

    loginLimiter.reset(`${ctx.ip}:${username}`);

    // A staff sign-in on a terminal is bound to that terminal, so later actions
    // record both the person and the station (spec §15).
    const auth = ctx.state.auth ?? security.resolve(ctx);

    /*
     * One account, one place at a time.
     *
     * If this person is already signed in somewhere, the password is not enough
     * — the device that has the session is asked first. That device is shown
     * who is asking and from where, and told that saying yes signs it out.
     *
     * The point is the audit trail. Every action in this product records who
     * did it, and that record only means something while "who" is one person;
     * a cashier's account open at the counter and in the back office makes the
     * log a record of an account rather than of a person.
     */
    if (services.access.liveSessionsForUser(user.id).length > 0) {
      const request = services.loginRequests.open({
        userId: user.id,
        userName: user.display_name,
        fromIp: ctx.ip,
        fromTerminalName: auth.actor.terminalName,
      });

      services.bus.publish({
        name: EventName.SYSTEM_LOGIN_REQUESTED,
        payload: {
          userId: user.id,
          request: services.loginRequests.publicView(request),
        },
      });

      services.audit.record({
        action: 'user.login_requested',
        actor: { kind: 'SYSTEM', userId: null, userName: null, terminalId: null, terminalName: null },
        entityType: 'user',
        entityId: user.id,
        detail: { username, fromTerminal: auth.actor.terminalName },
        clientIp: ctx.ip,
      });

      // 202: the credentials were right, and the answer is somebody else's.
      return new HttpResponse(202, JSON.stringify({
        pending: true,
        requestId: request.id,
        expiresInSeconds: services.loginRequests.publicView(request).expiresInSeconds,
      }), { 'content-type': 'application/json; charset=utf-8' });
    }

    const token = services.access.createUserSession({
      userId: user.id,
      terminalId: auth.terminal?.id ?? null,
      ttlSeconds: services.config.userSessionTtlSeconds,
      clientIp: ctx.ip,
    });
    services.access.touchLogin(user.id);

    services.audit.record({
      action: 'user.login',
      actor: {
        kind: 'USER', userId: user.id, userName: user.display_name,
        terminalId: auth.terminal?.id ?? null, terminalName: auth.actor.terminalName,
      },
      entityType: 'user',
      entityId: user.id,
      clientIp: ctx.ip,
    });

    return new HttpResponse(200, JSON.stringify({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      roles: services.access.roleKeysForUser(user.id),
      permissions: services.access.permissionsForUser(user.id),
    }), {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': userCookie(token, services.config.userSessionTtlSeconds),
    });
  });

  /**
   * The second device, waiting.
   *
   * Polled rather than pushed, because the device asking has no session yet and
   * so no socket to be pushed down — it is not signed in, which is the whole
   * point. When the answer is yes this is also where the sign-in completes: the
   * approval is claimed once, the sessions it displaces are ended, and the
   * cookie is issued in the same reply. An approval that could be spent twice
   * would be an approval for anybody.
   */
  router.get('/auth/login/:requestId', (ctx) => {
    const id = ctx.params['requestId']!;
    const state = services.loginRequests.state(id);

    if (state !== 'approved') {
      return new HttpResponse(200, JSON.stringify({ state }), {
        'content-type': 'application/json; charset=utf-8',
      });
    }

    const claimed = services.loginRequests.claim(id);
    if (!claimed) {
      return new HttpResponse(200, JSON.stringify({ state: 'expired' }), {
        'content-type': 'application/json; charset=utf-8',
      });
    }

    const user = services.access.getUser(claimed.userId);
    if (!user || user.active !== 1) throw unauthenticated('that account is no longer active');

    /*
     * The displaced sessions end here rather than when the answer was given.
     *
     * Ending them at the moment of approval would sign somebody out and then,
     * if the second device never came back, leave the account signed in
     * nowhere — an approval that cost a session and delivered none.
     */
    services.access.deleteSessionsForUser(user.id);
    services.bus.publish({
      name: EventName.SYSTEM_SESSION_ENDED,
      payload: { userId: user.id, reason: 'signed_in_elsewhere' },
    });

    const auth = ctx.state.auth ?? security.resolve(ctx);
    const token = services.access.createUserSession({
      userId: user.id,
      terminalId: auth.terminal?.id ?? null,
      ttlSeconds: services.config.userSessionTtlSeconds,
      clientIp: ctx.ip,
    });
    services.access.touchLogin(user.id);

    services.audit.record({
      action: 'user.login',
      actor: {
        kind: 'USER', userId: user.id, userName: user.display_name,
        terminalId: auth.terminal?.id ?? null, terminalName: auth.actor.terminalName,
      },
      entityType: 'user',
      entityId: user.id,
      detail: { approvedFromAnotherDevice: true },
      clientIp: ctx.ip,
    });

    return new HttpResponse(200, JSON.stringify({
      state: 'approved',
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      roles: services.access.roleKeysForUser(user.id),
      permissions: services.access.permissionsForUser(user.id),
    }), {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': userCookie(token, services.config.userSessionTtlSeconds),
    });
  });

  /**
   * The answer, given by the device that already holds the account.
   *
   * `requireUser` with no permission: this is not something a role grants. The
   * only person who may answer is the one being asked, and the service checks
   * that the request belongs to them before it takes the answer.
   */
  router.post('/auth/login-requests/:requestId', (ctx) => {
    const auth = ctx.state.auth!;
    const body = asObject(ctx.body);
    const approve = optionalBoolean(body, 'approve', false);

    const settled = services.loginRequests.answer(
      ctx.params['requestId']!, auth.user!.id, approve);
    if (settled === null) throw notFound('login request', ctx.params['requestId']!);

    services.audit.record({
      action: approve ? 'user.login_approved' : 'user.login_denied',
      actor: auth.actor,
      entityType: 'user',
      entityId: auth.user!.id,
      clientIp: ctx.ip,
    });

    return { state: settled };
  }, [security.requireUser()]);

  router.post('/auth/logout', (ctx) => {
    const token = readUserToken(ctx);
    if (token) services.access.deleteUserSession(token);

    const auth = ctx.state.auth ?? security.resolve(ctx);
    if (auth.user) {
      services.audit.record({
        action: 'user.logout',
        actor: auth.actor,
        entityType: 'user',
        entityId: auth.user.id,
        clientIp: ctx.ip,
      });
    }
    return new HttpResponse(200, JSON.stringify({ ok: true }), {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': clearUserCookie(),
    });
  });

  /**
   * Who am I, and what may I do? Every front-end calls this on load and renders
   * from the answer, so the UI and the server can never disagree about
   * permissions.
   */
  router.get('/auth/me', (ctx) => {
    const auth = ctx.state.auth ?? security.resolve(ctx);
    const profile = services.settings.profile();

    return {
      authenticated: auth.user !== null || auth.terminal !== null,
      actor: auth.actor,
      permissions: auth.permissions,
      user: auth.user
        ? {
            id: auth.user.id,
            username: auth.user.username,
            displayName: auth.user.display_name,
            roles: services.access.roleKeysForUser(auth.user.id),
          }
        : null,
      terminal: auth.terminal
        ? {
            id: auth.terminal.id,
            type: auth.terminal.terminal_type,
            name: services.terminalRepository.name(auth.terminal),
            soundProfile: services.terminalRepository.soundProfile(auth.terminal),
            tableId: services.tables.getByTerminal(auth.terminal.id)?.id ?? null,
          }
        : null,
      mode: services.gate.mode,
      capabilities: services.gate.current.capabilities,
      /*
       * Somebody asking to take this account, if anybody is.
       *
       * The question also arrives as a realtime event, which is how a screen
       * that is already open hears it. This is for the screen that was not:
       * a tablet woken from sleep mid-question would otherwise never be asked,
       * and the person at the other device would wait out the minute for
       * nothing.
       */
      pendingLogins: auth.user ? services.loginRequests.pendingFor(auth.user.id) : [],
      locale: profile?.defaultLocale ?? 'en',
      themeId: profile?.themeId ?? 'light',
      // What this restaurant calls its people. Sent to every screen at boot,
      // because the word appears on the floor tablet's heading and on the
      // diner's "call" button, not only in the console.
      roleNames: services.access.roleNames(),
      // What it has switched off. Sent the same way and for the same reason:
      // a restaurant that turned sound off means every screen, not the console.
      preferences: {
        notifications: services.settings.get<boolean>('notifications.enabled') !== false,
        sounds: services.settings.get<boolean>('notifications.sounds') !== false,
        animations: services.settings.get<boolean>('ui.animations') !== false,
      },
    };
  });

  return router;
}
