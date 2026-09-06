/**
 * Languages and themes the restaurant authors for itself.
 *
 * The workflow these routes serve is deliberately low-tech, because it has to
 * work on a restaurant PC with no account, no API key and no integration:
 *
 *     GET  /api/languages/:locale/bundle   copy this JSON
 *          …translate it anywhere at all…
 *     POST /api/languages                  paste it back
 *
 * The bundle carries both halves of a language — the interface strings *and*
 * every word the owner typed into their own menu — so a new language is a
 * whole language, not a translated frame around Arabic food.
 */

import {
  asObject, optionalBoolean, optionalString, Permission, requireString, validationError,
  type TextDirection,
} from '@qserve/shared';
import { HttpResponse, Router } from '@qserve/http';
import type { Services } from '../../container.js';
import type { AppState } from '../../core/security.js';
import { ContentTranslationRepository } from '../../modules/translations/content.js';

export function createPackRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;
  const loopbackOnly = security.adminListenerOnly();
  const canManageSettings = security.requireUser(Permission.SETTINGS_MANAGE);
  const authoring = services.packAuthoring;

  /* ------------------------------------------------------------ languages */

  router.get('/languages', () => ({
    languages: authoring.listLanguages(),
    /** What a translator will meet in the content half, for the summary line. */
    contentKinds: ContentTranslationRepository.translatableKinds,
  }), [loopbackOnly, security.requirePermission(Permission.SETTINGS_MANAGE)]);

  /**
   * The JSON to copy. `mode` decides what the values hold:
   *
   *   template  every value blank — start from nothing
   *   source    the text of an existing language — translate over it
   *   current   what this language already has — fix a wording
   */
  router.get('/languages/:locale/bundle', (ctx) => {
    const mode = ctx.query.get('mode') ?? 'source';
    if (mode !== 'template' && mode !== 'source' && mode !== 'current') {
      throw validationError('mode must be "template", "source" or "current"', { field: 'mode' });
    }
    const direction = ctx.query.get('direction');
    if (direction !== null && direction !== 'ltr' && direction !== 'rtl') {
      throw validationError('direction must be "ltr" or "rtl"', { field: 'direction' });
    }

    return authoring.exportBundle({
      targetLocale: ctx.params['locale']!,
      mode,
      ...(ctx.query.get('sourceLocale') ? { sourceLocale: ctx.query.get('sourceLocale')! } : {}),
      ...(ctx.query.get('name') ? { name: ctx.query.get('name')! } : {}),
      ...(ctx.query.get('englishName') ? { englishName: ctx.query.get('englishName')! } : {}),
      ...(direction ? { direction: direction as TextDirection } : {}),
    });
  }, [loopbackOnly, security.requirePermission(Permission.SETTINGS_MANAGE)]);

  /** Save a pasted bundle: this is what "add a language" actually does. */
  router.post('/languages', (ctx) => {
    const body = asObject(ctx.body);
    const direction = optionalString(body, 'direction', { max: 3 });
    if (direction !== null && direction !== 'ltr' && direction !== 'rtl') {
      throw validationError('direction must be "ltr" or "rtl"', { field: 'direction' });
    }

    return authoring.importBundle({
      raw: parseBundleField(body['bundle']),
      override: {
        ...(optionalString(body, 'locale', { max: 35 })
          ? { locale: optionalString(body, 'locale', { max: 35 })! } : {}),
        ...(optionalString(body, 'name', { max: 60 })
          ? { name: optionalString(body, 'name', { max: 60 })! } : {}),
        ...(optionalString(body, 'englishName', { max: 60 })
          ? { englishName: optionalString(body, 'englishName', { max: 60 })! } : {}),
        ...(direction ? { direction: direction as TextDirection } : {}),
      },
      enable: optionalBoolean(body, 'enable', true),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [loopbackOnly, canManageSettings]);

  router.delete('/languages/:locale', (ctx) => authoring.deleteLanguage({
    locale: ctx.params['locale']!,
    actor: ctx.state.auth!.actor,
    clientIp: ctx.ip,
  }), [loopbackOnly, canManageSettings]);

  /* --------------------------------------------------------------- themes */

  router.get('/themes-authoring', () => ({ themes: authoring.listThemes() }),
    [loopbackOnly, security.requirePermission(Permission.SETTINGS_MANAGE)]);

  /** The theme JSON to copy, edit and paste back — same loop as a language. */
  router.get('/themes-authoring/:id/pack', (ctx) => authoring.exportTheme(ctx.params['id']!),
    [loopbackOnly, security.requirePermission(Permission.SETTINGS_MANAGE)]);

  router.post('/themes-authoring', (ctx) => {
    const body = asObject(ctx.body);
    return authoring.importTheme({
      raw: parseBundleField(body['theme']),
      override: {
        ...(optionalString(body, 'id', { max: 32 })
          ? { id: optionalString(body, 'id', { max: 32 })! } : {}),
        ...(optionalString(body, 'name', { max: 60 })
          ? { name: optionalString(body, 'name', { max: 60 })! } : {}),
      },
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [loopbackOnly, canManageSettings]);

  router.delete('/themes-authoring/:id', (ctx) => {
    authoring.deleteTheme({
      id: ctx.params['id']!,
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
    return HttpResponse.noContent();
  }, [loopbackOnly, canManageSettings]);

  return router;
}

/**
 * The console posts the pasted text as a string, because that is what is in the
 * textarea. Accepting a parsed object too keeps the endpoint usable by hand.
 */
function parseBundleField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw validationError(`the pasted text is not valid JSON: ${String(error)}`, {
      field: 'bundle',
    });
  }
}
