/**
 * Currencies (spec §35).
 *
 * A restaurant near a border, or one serving tourists, prices some dishes in
 * one currency and some in another. Adding the lira is typing `TRY` and `₺`,
 * not waiting for a release — so this is a table the owner writes, exactly like
 * the menu itself.
 *
 * One of them is the **base**: what the till counts, what the reports add up,
 * what a bill settles in. Everything else records what it is worth against it.
 */

import {
  asObject, CURRENCY_CODE_PATTERN, CurrencyDisplay, EventName, optionalBoolean,
  optionalLocalised,
  optionalNumber, optionalString, Permission, requireNumber, requireString,
  validationError,
} from '@qserve/shared';
import { HttpResponse, Router } from '@qserve/http';
import type { Services } from '../../container.js';
import type { AppState } from '../../core/security.js';

export function createCurrencyRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;
  const loopbackOnly = security.adminListenerOnly();
  const canManage = security.requireUser(Permission.SETTINGS_MANAGE);

  const announce = (): void => {
    // Every price on every screen is formatted from these, so a change has to
    // reach the tables without anybody reloading a page.
    services.bus.publish({
      name: EventName.MENU_UPDATED,
      payload: { at: new Date().toISOString(), reason: 'currencies' },
    });
  };

  const record = (
    ctx: { state: AppState; ip: string | null },
    action: string,
    code: string,
    snapshot: { before?: unknown; after?: unknown } = {},
  ): void => {
    services.audit.record({
      action, actor: ctx.state.auth!.actor, entityType: 'currency', entityId: code,
      ...snapshot, clientIp: ctx.ip,
    });
  };

  /**
   * Readable by any terminal: a diner's phone has to format the prices it is
   * shown, and it cannot do that without knowing the symbols.
   */
  router.get('/currencies', () => ({
    currencies: services.currencies.list(),
    base: services.currencies.base(),
  }), [security.requirePermission(Permission.MENU_VIEW)]);

  router.post('/currencies', (ctx) => {
    const body = asObject(ctx.body);
    const code = requireString(body, 'code', {
      min: 3, max: 3, pattern: CURRENCY_CODE_PATTERN,
    }).toUpperCase();

    const currency = services.currencies.create({
      code,
      symbol: requireString(body, 'symbol', { min: 1, max: 8 }),
      name: optionalLocalised(body, 'name', { max: 60 }),
      decimals: optionalNumber(body, 'decimals', { min: 0, max: 4 }) ?? 2,
      symbolPosition: parsePosition(body),
      display: parseDisplay(body),
      // A rate of zero would make every price in this currency free.
      rateToBase: requireNumber(body, 'rateToBase', {
        min: 0.000001, max: 1_000_000, integer: false,
      }),
    });

    record(ctx, 'currency.created', currency.code, { after: currency });
    announce();
    return currency;
  }, [loopbackOnly, canManage]);

  router.patch('/currencies/:code', (ctx) => {
    const code = ctx.params['code']!.toUpperCase();
    const before = services.currencies.get(code);
    if (!before) throw validationError('no such currency', { field: 'code' });
    const body = asObject(ctx.body);

    const after = services.currencies.update(code, {
      ...(body['symbol'] !== undefined
        ? { symbol: requireString(body, 'symbol', { min: 1, max: 8 }) } : {}),
      ...(body['name'] !== undefined
        ? { name: optionalLocalised(body, 'name', { max: 60 }) } : {}),
      ...(body['decimals'] !== undefined
        ? { decimals: requireNumber(body, 'decimals', { min: 0, max: 4 }) } : {}),
      ...(body['symbolPosition'] !== undefined
        ? { symbolPosition: parsePosition(body) } : {}),
      ...(body['display'] !== undefined ? { display: parseDisplay(body) } : {}),
      ...(body['rateToBase'] !== undefined
        ? { rateToBase: requireNumber(body, 'rateToBase', {
            min: 0.000001, max: 1_000_000, integer: false,
          }) } : {}),
      ...(body['enabled'] !== undefined
        ? { enabled: optionalBoolean(body, 'enabled', true) } : {}),
      ...(body['sortOrder'] !== undefined
        ? { sortOrder: requireNumber(body, 'sortOrder', { min: 0, max: 9999 }) } : {}),
    });

    record(ctx, 'currency.updated', code, { before, after });
    announce();
    return after;
  }, [loopbackOnly, canManage]);

  /**
   * Move the base. Every other rate is re-expressed against the new one in the
   * same transaction, so no price silently changes meaning.
   */
  router.post('/currencies/:code/base', (ctx) => {
    const code = ctx.params['code']!.toUpperCase();
    const before = services.currencies.base();
    const after = services.currencies.setBase(code);

    // The restaurant profile carries the same fact for receipts and reports.
    services.settings.updateRestaurant({
      currency: {
        code: after.code,
        symbol: after.symbol,
        decimals: after.decimals,
        symbolPosition: after.symbolPosition,
      },
    });

    record(ctx, 'currency.base_changed', code, { before, after });
    announce();
    return { base: after, currencies: services.currencies.list() };
  }, [loopbackOnly, canManage]);

  /** What would break if this currency went away — asked before offering to delete. */
  router.get('/currencies/:code/usage', (ctx) =>
    services.currencies.usage(ctx.params['code']!.toUpperCase()),
  [loopbackOnly, security.requirePermission(Permission.SETTINGS_MANAGE)]);

  router.delete('/currencies/:code', (ctx) => {
    const code = ctx.params['code']!.toUpperCase();
    const before = services.currencies.get(code);
    services.currencies.delete(code);

    record(ctx, 'currency.deleted', code, { before });
    announce();
    return HttpResponse.noContent();
  }, [loopbackOnly, canManage]);

  return router;
}

/** Whether prices in this currency are written as the code or the symbol. */
function parseDisplay(body: Record<string, unknown>): CurrencyDisplay {
  const value = optionalString(body, 'display', { max: 6 }) ?? CurrencyDisplay.SYMBOL;
  if (value !== CurrencyDisplay.CODE && value !== CurrencyDisplay.SYMBOL) {
    throw validationError('display must be "CODE" or "SYMBOL"', { field: 'display' });
  }
  return value;
}

function parsePosition(body: Record<string, unknown>): 'before' | 'after' {
  const value = optionalString(body, 'symbolPosition', { max: 6 }) ?? 'after';
  if (value !== 'before' && value !== 'after') {
    throw validationError('symbolPosition must be "before" or "after"', {
      field: 'symbolPosition',
    });
  }
  return value;
}
