/**
 * App lock routes.
 *
 * Two of these have to work while the console is locked, which is why the lock
 * status and the unlock attempt carry no permission guard: nobody can sign in
 * past a lock screen, so requiring a session to get past it would be circular.
 * Everything else here needs a signed-in manager, exactly like the rest of the
 * settings screen.
 */

import { asObject, optionalNumber, optionalString, Permission, requireBoolean, requireString } from '@qserve/shared';
import { HttpResponse, Router } from '@qserve/http';
import type { Services } from '../../container.js';
import { clearUnlockCookie, unlockCookie } from '../../core/app-lock.js';
import type { AppState } from '../../core/security.js';

/** Paths that stay reachable while the console is locked. */
export const LOCK_ALLOWED_PATHS: readonly string[] = [
  '/api/lock',
  '/api/lock/unlock',
];

export function createLockRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;
  const loopbackOnly = security.adminListenerOnly();

  /**
   * The lock screen draws itself from this one response, so it never has to
   * call `/api/system` — which stays behind the lock along with everything else.
   */
  router.get('/lock', (ctx) => {
    const status = services.appLock.status(ctx.req.headers.cookie);
    const profile = services.settings.profile();
    const locale = profile?.defaultLocale ?? 'en';
    return {
      ...status,
      restaurantName: profile?.name ?? null,
      locale,
      direction: services.translations.direction(locale),
      themeId: profile?.themeId ?? 'light',
    };
  }, [loopbackOnly]);

  router.post('/lock/unlock', (ctx) => {
    const body = asObject(ctx.body);
    const token = services.appLock.unlock(
      requireString(body, 'passphrase', { min: 1, max: 200 }),
      ctx.ip,
    );
    return jsonWithCookie(
      { unlocked: true },
      unlockCookie(token, services.appLock.status(undefined).idleMinutes),
    );
  }, [loopbackOnly]);

  /** "Lock now" — used when stepping away from the machine. */
  router.post('/lock/engage', (ctx) => {
    services.appLock.lockAll(ctx.state.auth!.actor, ctx.ip);
    return jsonWithCookie({ locked: true }, clearUnlockCookie());
  }, [loopbackOnly, security.requireUser()]);

  /**
   * Turn the lock on or off, change its passphrase, hint or idle timeout.
   *
   * On its own path rather than `PUT /lock`, because the guard matches by path:
   * `GET /lock` has to stay open while locked, and sharing a path with it would
   * let a browser holding a stale session cookie switch the lock off from the
   * lock screen.
   */
  router.put('/lock/settings', (ctx) => {
    const body = asObject(ctx.body);
    const enabled = requireBoolean(body, 'enabled');
    const status = services.appLock.configure({
      enabled,
      passphrase: optionalString(body, 'passphrase', { max: 200 }),
      currentPassphrase: optionalString(body, 'currentPassphrase', { max: 200 }),
      hint: body['hint'] === undefined ? undefined : optionalString(body, 'hint', { max: 120 }),
      ...(body['idleMinutes'] === undefined
        ? {}
        : { idleMinutes: optionalNumber(body, 'idleMinutes', { min: 1, max: 1440 }) ?? 30 }),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });

    // Turning the lock on locks the machine immediately; whoever set it has to
    // prove they can get back in before they walk away from it.
    return jsonWithCookie(status, clearUnlockCookie());
  }, [loopbackOnly, security.requireUser(Permission.SETTINGS_MANAGE)]);

  return router;
}

const jsonWithCookie = (value: unknown, cookie: string): HttpResponse =>
  new HttpResponse(200, JSON.stringify(value), {
    'content-type': 'application/json; charset=utf-8',
    'set-cookie': cookie,
  });
