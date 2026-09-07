/**
 * Developer mode (spec §30).
 *
 * The developer needs exactly the workflow a restaurant owner has, aimed one
 * level lower: instead of adding a language *to their restaurant*, they add one
 * *to QServe* — a file in `locales/` that every installation then ships with,
 * and that every restaurant can translate their own menu from.
 *
 * Three things keep this safe to have in the codebase at all:
 *
 *   - it is off unless `QSERVE_DEVELOPER_MODE=true`, which no packaged build
 *     sets, so a restaurant's console simply has no such routes;
 *   - it is loopback-only and needs a signed-in manager on top;
 *   - it writes only into the locales and themes directories, under a name
 *     derived from the validated pack's own code.
 */

import {
  asObject, notFound, Permission, validationError, type TextDirection,
} from '@qserve/shared';
import { HttpResponse, Router, type Middleware } from '@qserve/http';
import type { Services } from '../../container.js';
import type { AppState } from '../../core/security.js';

export function createDeveloperRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;

  /**
   * Developer mode is not a permission a restaurant can grant itself: it is a
   * property of how this copy of the application was started.
   */
  const developerOnly: Middleware<AppState> = (ctx, next) => {
    if (!services.config.developerMode) throw notFound('developer mode');
    return next();
  };

  const gate = [
    developerOnly,
    security.adminListenerOnly(),
    security.requireUser(Permission.SETTINGS_MANAGE),
  ];

  /** What is on disk, what loaded, and what was rejected and why. */
  router.get('/dev/packs', () => services.shippedPacks.overview(), gate);

  /* ------------------------------------------------------------ languages */

  router.get('/dev/locales/:locale/template', (ctx) => {
    const direction = ctx.query.get('direction');
    return services.shippedPacks.localeTemplate({
      locale: ctx.params['locale']!,
      from: ctx.query.get('from'),
      ...(ctx.query.get('name') ? { name: ctx.query.get('name')! } : {}),
      ...(ctx.query.get('englishName') ? { englishName: ctx.query.get('englishName')! } : {}),
      ...(direction === 'rtl' || direction === 'ltr'
        ? { direction: direction as TextDirection } : {}),
    });
  }, gate);

  /** Validate without writing, so the console can show what is still missing. */
  router.post('/dev/locales/check', (ctx) => {
    const { pack, issues } = services.shippedPacks.checkLocale(parseJsonField(ctx.body, 'pack'));
    return {
      locale: pack.locale,
      issues,
      errors: issues.filter((issue) => issue.severity === 'error').length,
      warnings: issues.filter((issue) => issue.severity !== 'error').length,
    };
  }, gate);

  router.post('/dev/locales', (ctx) => services.shippedPacks.installLocale({
    raw: parseJsonField(ctx.body, 'pack'),
    actor: ctx.state.auth!.actor,
    clientIp: ctx.ip,
  }), gate);

  router.delete('/dev/locales/:locale', (ctx) => {
    services.shippedPacks.removeLocale({
      locale: ctx.params['locale']!,
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
    return HttpResponse.noContent();
  }, gate);

  /* --------------------------------------------------------------- themes */

  router.get('/dev/themes/:id/template', (ctx) => services.shippedPacks.themeTemplate({
    id: ctx.params['id']!,
    from: ctx.query.get('from'),
  }), gate);

  router.post('/dev/themes/check', (ctx) => {
    const { pack, issues } = services.shippedPacks.checkTheme(parseJsonField(ctx.body, 'pack'));
    return { id: pack.id, issues, errors: issues.length };
  }, gate);

  router.post('/dev/themes', (ctx) => services.shippedPacks.installTheme({
    raw: parseJsonField(ctx.body, 'pack'),
    actor: ctx.state.auth!.actor,
    clientIp: ctx.ip,
  }), gate);

  router.delete('/dev/themes/:id', (ctx) => {
    services.shippedPacks.removeTheme({
      id: ctx.params['id']!,
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
    return HttpResponse.noContent();
  }, gate);

  /* --------------------------------------------------------- vendor info */

  /**
   * The vendor's own details, as they will ship. A restaurant that has never
   * been online sees exactly this on its licence screen, so it is prepared here
   * once rather than explained on the phone every time.
   */
  router.get('/dev/vendor', () => ({
    file: services.shippedVendor.path,
    info: services.shippedVendor.current,
    template: services.shippedVendor.template(),
  }), gate);

  router.put('/dev/vendor', (ctx) => ({
    info: services.shippedVendor.save(
      parseJsonField(ctx.body, 'vendor'),
      ctx.state.auth!.actor,
      ctx.ip,
    ),
  }), gate);

  return router;
}

/** The console posts the pasted text as a string; a parsed object works too. */
function parseJsonField(body: unknown, field: string): unknown {
  const value = asObject(body)[field];
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch (error) {
    // A stray comma in a pasted file is an everyday mistake, not a server
    // fault, so it comes back as a validation message the console can show.
    throw validationError(`the pasted text is not valid JSON: ${String(error)}`, { field });
  }
}
