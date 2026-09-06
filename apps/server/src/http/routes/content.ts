/**
 * Language packs, themes, images — and the QR landing page.
 *
 * These routes are open to any terminal on the LAN because a diner's phone
 * needs the menu's language pack and theme before it has any session at all.
 * They are read-only and expose nothing but presentation data.
 */

import {
  Capability, forbidden, notFound, optionalString, Permission,
  requireEnum, unauthenticated, validationError,
} from '@qserve/shared';
import { HttpResponse, Router } from '@qserve/http';
import type { Services } from '../../container.js';
import { clearTerminalCookie, terminalCookie, type AppState } from '../../core/security.js';

export function createContentRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;

  /* ------------------------------------------------------------- i18n */

  router.get('/i18n/locales', () => {
    const profile = services.settings.profile();
    return {
      locales: services.translations.summaries(profile?.enabledLocales ?? ['en']),
      defaultLocale: profile?.defaultLocale ?? 'en',
    };
  });

  /**
   * A fully resolved dictionary: the requested locale merged over its fallback
   * chain, so a terminal never has to implement fallback and a partially
   * translated language still renders every screen.
   */
  router.get('/i18n/:locale', (ctx) => {
    const locale = ctx.params['locale']!;
    if (!services.translations.has(locale)) throw notFound('locale', locale);
    return services.translations.resolved(locale);
  });

  router.get('/i18n-diagnostics', () => services.translations.diagnostics(),
    [security.requirePermission(Permission.SETTINGS_MANAGE)]);

  /* ----------------------------------------------------------- themes */

  router.get('/themes', () => {
    const profile = services.settings.profile();
    return { themes: services.themes.summaries(profile?.themeId ?? 'light') };
  });

  router.get('/themes/:id', (ctx) => services.themes.get(ctx.params['id']!));

  /** The theme as a ready-to-inject CSS custom-property block. */
  router.get('/themes/:id/css', (ctx) => {
    const css = services.themes.css(ctx.params['id']!);
    return new HttpResponse(200, css, {
      'content-type': 'text/css; charset=utf-8',
      // Themes change only when an operator edits one, and the id is in the
      // path, so this is safe to hold for a long time on a slow tablet.
      'cache-control': 'public, max-age=3600',
    });
  });

  router.get('/theme-diagnostics', () => services.themes.diagnostics(),
    [security.requirePermission(Permission.SETTINGS_MANAGE)]);

  /* ----------------------------------------------------------- assets */

  router.get('/assets', (ctx) => ({
    assets: services.assets.list(ctx.query.get('kind') ?? undefined),
  }), [security.requirePermission(Permission.MENU_MANAGE)]);

  router.post('/assets', async (ctx) => {
    const bytes = ctx.body;
    if (!Buffer.isBuffer(bytes)) {
      throw validationError('send the image as a binary body with its content-type');
    }
    const kind = requireEnum(
      { kind: ctx.query.get('kind') ?? 'product' },
      'kind',
      ['logo', 'product', 'category'] as const,
    );

    return services.assets.store({
      bytes,
      contentType: (ctx.req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '',
      kind,
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [security.requirePermission(Permission.MENU_MANAGE)]);

  router.delete('/assets/:id', async (ctx) => {
    await services.assets.delete({
      id: ctx.params['id']!,
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
    return { deleted: ctx.params['id'] };
  }, [security.requirePermission(Permission.MENU_MANAGE)]);

  return router;
}

/**
 * Public asset serving, mounted outside `/api` so an `<img src>` is a plain URL.
 * Unauthenticated on purpose: a diner has to see the burger photo before they
 * have any session, and the id is a random token rather than a guessable name.
 */
export function createAssetFileRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();

  router.get('/assets/:id', async (ctx) => {
    const asset = await services.assets.read(ctx.params['id']!);
    return new HttpResponse(200, asset.bytes, {
      'content-type': asset.contentType,
      'content-length': String(asset.bytes.length),
      // Content-addressed: an edited image gets a new id, so this never staleness-traps.
      'cache-control': 'public, max-age=86400, immutable',
    });
  });

  return router;
}

/**
 * QR landing (spec §8, §11, §12, §16).
 *
 * `GET /r/:restaurantId/:target?k=…` is what every printed QR points at. It
 * verifies the code, creates a terminal session, and redirects the browser to
 * the right application for that station. Staff never type an IP address.
 */
export function createEnrolmentRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();

  router.get('/r/:restaurantId/:target', (ctx) => {
    // Before activation there is no live service to enrol into, and the LAN
    // listener is not even bound — this is belt and braces for the case where
    // an operator previews the URL from the console.
    services.gate.assert(Capability.LAN_SERVER);

    const token = ctx.query.get('k');
    if (!token) throw unauthenticated('this QR code is incomplete');

    const resolved = services.terminals.resolveScan({
      restaurantId: ctx.params['restaurantId']!,
      target: ctx.params['target']!,
      token,
    });

    // One indistinguishable failure for a wrong restaurant, an unknown table
    // and a bad code: a scanner should learn nothing by probing.
    if (!resolved) throw forbidden('this QR code is not valid for this restaurant');

    const sessionToken = services.terminals.enrol({
      row: resolved.row,
      ttlSeconds: services.config.terminalSessionTtlSeconds,
      clientIp: ctx.ip,
      userAgent: optionalString(
        { ua: ctx.req.headers['user-agent'] ?? '' }, 'ua', { max: 300 },
      ),
    });

    services.audit.record({
      action: 'terminal.enrolled',
      actor: {
        kind: 'TERMINAL',
        userId: null,
        userName: null,
        terminalId: resolved.row.id,
        terminalName: resolved.row.public_code,
      },
      entityType: 'terminal',
      entityId: resolved.row.id,
      detail: { type: resolved.row.terminal_type, target: ctx.params['target'] },
      clientIp: ctx.ip,
    });

    return new HttpResponse(302, null, {
      location: resolved.landingPath,
      'set-cookie': terminalCookie(sessionToken, services.config.terminalSessionTtlSeconds),
    });
  });

  /** Sign the current device out of its station, for a lost or shared device. */
  router.post('/api/terminal/leave', (ctx) => {
    const terminal = ctx.state.auth?.terminal;
    if (!terminal) throw notFound('terminal session');

    services.terminalRepository.deleteSessionsForTerminal(terminal.id);
    // A station signing itself out matters: it is how a lost tablet is cut off,
    // and the log is where an owner checks that it actually happened.
    services.audit.record({
      action: 'terminal.left',
      actor: ctx.state.auth!.actor,
      entityType: 'terminal',
      entityId: terminal.id,
      clientIp: ctx.ip,
    });
    return new HttpResponse(200, JSON.stringify({ ok: true }), {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': clearTerminalCookie(),
    });
  });

  return router;
}
