/**
 * System status, first-run setup and staff authentication.
 *
 * The setup routes are the SETUP-mode entry point (spec §40): create the
 * restaurant, create the owner account, then build the real menu. None of them
 * needs a licence, and none of the data they write is thrown away at activation.
 */

import {
  asObject, conflict, DEFAULT_CURRENCY, LOCALE_CODE_PATTERN, optionalString,
  requireLocalised, requireString, SystemRole, unauthenticated, validationError,
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

  router.post('/auth/logout', (ctx) => {
    const token = readUserToken(ctx);
    if (token) services.access.deleteUserSession(token);
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
      locale: profile?.defaultLocale ?? 'en',
      themeId: profile?.themeId ?? 'light',
    };
  });

  return router;
}
