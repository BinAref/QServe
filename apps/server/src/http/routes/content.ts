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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
/**
 * What an uploaded image is allowed to be, once it is being served back.
 *
 * Four of the five formats this store accepts are decoded by an image decoder
 * and can only ever be a wrong picture. SVG is XML, and a browser asked to
 * navigate to one renders it as a document on this origin — able, in principle,
 * to carry script, embedded HTML, and a convincing copy of the console's own
 * sign-in form at the restaurant's own address.
 *
 * `sandbox` is the answer, and it is worth more than the upload checks: the
 * document is given an opaque origin with no scripts, no forms and no access to
 * anything of ours, whatever the file turned out to contain and whatever the
 * application-wide policy is loosened to later. `<img>` and `<link rel="icon">`
 * are untouched — a CSP travels with a document, and an image being decoded is
 * not one.
 *
 * Route headers replace the server's defaults rather than adding to them, so
 * this policy states everything it needs.
 */
const UPLOADED_CONTENT_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export function createAssetFileRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();

  router.get('/assets/:id', async (ctx) => {
    const asset = await services.assets.read(ctx.params['id']!);
    return new HttpResponse(200, asset.bytes, {
      'content-type': asset.contentType,
      'content-length': String(asset.bytes.length),
      // Content-addressed: an edited image gets a new id, so this never staleness-traps.
      'cache-control': 'public, max-age=86400, immutable',
      'content-security-policy': UPLOADED_CONTENT_POLICY,
    });
  });

  /**
   * The restaurant's own mark, as the icon of every screen it runs (spec §34).
   *
   * A restaurant that has uploaded a logo in Console → Settings → Brand should
   * see it on the browser tab, on the phone's home screen when a waiter adds
   * the station there, and in the task switcher — not the QServe mark. So every
   * front-end points its `<link rel="icon">` here rather than at a file, and
   * this answers with whatever the restaurant has chosen today.
   *
   * Unauthenticated, like the images beside it: a browser asks for a favicon
   * before it has run a line of the page's script, cookies and all.
   */
  router.get('/app-icon', async (ctx) => {
    const profile = services.settings.profile();
    const logoId = profile?.logoAssetId ?? null;

    /*
     * The icon changes when the restaurant changes it and at no other time, so
     * it is revalidated rather than cached blind: an owner who uploads a new
     * logo should not have to explain to their staff how to clear a cache. The
     * tag is the asset id, which is a hash of the image itself.
     */
    const etag = `"icon-${logoId ?? 'qserve'}"`;
    if (ctx.req.headers['if-none-match'] === etag) {
      /*
       * The policy travels on the 304 as well as the 200.
       *
       * A browser answering from its cache keeps the headers it stored with the
       * body, and takes from the 304 only what the 304 restates. Leave the
       * policy off and every device that fetched an icon before this code
       * existed goes on using the response it already has — unsandboxed — for
       * as long as its cache survives. Which is exactly the case that matters:
       * the icon that was uploaded before anyone was checking.
       */
      return new HttpResponse(304, Buffer.alloc(0), {
        etag,
        'cache-control': 'no-cache',
        'content-security-policy': UPLOADED_CONTENT_POLICY,
      });
    }

    if (logoId) {
      // A logo deleted from under the profile must not take the icon — and with
      // it the page's `<head>` — down with it.
      const asset = await services.assets.read(logoId).catch(() => null);
      if (asset) {
        return new HttpResponse(200, asset.bytes, {
          'content-type': asset.contentType,
          'content-length': String(asset.bytes.length),
          'cache-control': 'no-cache',
          'content-security-policy': UPLOADED_CONTENT_POLICY,
          etag,
        });
      }
    }

    const fallback = await readFile(join(services.config.webRoot, 'shared', 'favicon.svg'));
    return new HttpResponse(200, fallback, {
      'content-type': 'image/svg+xml',
      'content-length': String(fallback.length),
      'cache-control': 'no-cache',
      'content-security-policy': UPLOADED_CONTENT_POLICY,
      etag,
    });
  });

  /**
   * The manifest that makes "add to home screen" produce the restaurant's own
   * app: its name, its mark, its colours. Each front-end asks for its own, so a
   * waiter's home screen gains "Anwar — Waiter" pointing at the waiter station
   * rather than one nameless icon for all six.
   */
  router.get('/app.webmanifest', (ctx) => {
    const profile = services.settings.profile();
    const station = ctx.query.get('app') ?? 'console';
    // Whitelisted rather than interpolated: `start_url` comes from a query
    // string, and a manifest is not the place to find out what that allows.
    const known = ['console', 'customer', 'waiter', 'cashier', 'kitchen', 'printer'];
    const app = known.includes(station) ? station : 'console';

    const name = localisedName(profile) ?? 'QServe';
    return new HttpResponse(200, Buffer.from(JSON.stringify({
      name: `${name} — ${app}`,
      short_name: name,
      start_url: `/${app}/`,
      scope: `/${app}/`,
      display: 'standalone',
      background_color: '#101418',
      theme_color: '#101418',
      icons: [
        // One entry, no sizes: the icon is whatever the restaurant uploaded, and
        // declaring sizes we have not made would be a lie the launcher acts on.
        { src: '/app-icon', sizes: 'any', purpose: 'any' },
      ],
    }, null, 2)), {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-cache',
    });
  });

  return router;
}

/** The restaurant's name in its own default language, for a manifest or a tab. */
function localisedName(profile: { name: unknown; defaultLocale?: string } | null): string | null {
  if (!profile) return null;
  const { name } = profile;
  if (typeof name === 'string') return name || null;
  if (name && typeof name === 'object') {
    const entries = name as Record<string, string>;
    const preferred = profile.defaultLocale ? entries[profile.defaultLocale] : undefined;
    return preferred || Object.values(entries).find((value) => Boolean(value)) || null;
  }
  return null;
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
