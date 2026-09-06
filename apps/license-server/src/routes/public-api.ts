/**
 * The only endpoints a restaurant installation ever calls (spec §38).
 *
 * Four routes, all of them licence administration. There is deliberately no
 * endpoint here that could accept a menu, an order, a price or a diner: the
 * license server is not allowed to learn those things.
 */

import {
  asObject, DEVICE_FINGERPRINT_PATTERN, optionalString, requireString,
  AppError, ErrorCode, type ActivationRequest, type DeactivationRequest,
  type DeviceFingerprint, type RestaurantId,
} from '@qserve/shared';
import { RateLimiter, Router, type RequestContext } from '@qserve/http';
import type { LicenseService } from '../service.js';

/**
 * Activation is the one unauthenticated write in the system, so it is rate
 * limited per source address. The key checksum already makes blind guessing
 * hopeless; this caps the damage from a client stuck in a retry loop.
 */
const activationLimiter = new RateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });

function limit(ctx: RequestContext<Record<string, unknown>>): void {
  const verdict = activationLimiter.check(ctx.ip);
  if (!verdict.allowed) {
    throw new AppError(ErrorCode.RATE_LIMITED, 'too many licence requests from this address', {
      status: 429,
      messageKey: 'error.rate_limited',
      details: { retryAfterSeconds: verdict.retryAfterSeconds },
    });
  }
}

function parseActivation(body: unknown): ActivationRequest {
  const source = asObject(body);
  const restaurantId = optionalString(source, 'restaurantId', { max: 32 });
  const restaurantName = optionalString(source, 'restaurantName', { max: 200 });

  return {
    licenseKey: requireString(source, 'licenseKey', { min: 20, max: 40 }),
    deviceFingerprint: requireString(source, 'deviceFingerprint', {
      pattern: DEVICE_FINGERPRINT_PATTERN, min: 64, max: 64,
    }) as DeviceFingerprint,
    deviceLabel: optionalString(source, 'deviceLabel', { max: 120 }) ?? '',
    appVersion: requireString(source, 'appVersion', { max: 40 }),
    nonce: requireString(source, 'nonce', { min: 8, max: 64 }),
    ...(restaurantId ? { restaurantId: restaurantId as RestaurantId } : {}),
    ...(restaurantName ? { restaurantName } : {}),
  };
}

function parseDeactivation(body: unknown): DeactivationRequest {
  const source = asObject(body);
  return {
    licenseKey: requireString(source, 'licenseKey', { min: 20, max: 40 }),
    deviceFingerprint: requireString(source, 'deviceFingerprint', {
      pattern: DEVICE_FINGERPRINT_PATTERN, min: 64, max: 64,
    }) as DeviceFingerprint,
    reason: optionalString(source, 'reason', { max: 200 }) ?? 'moving to another device',
    nonce: requireString(source, 'nonce', { min: 8, max: 64 }),
  };
}

export function createPublicApi(service: LicenseService): Router {
  const router = new Router();

  /** Bind this device to this licence and receive an offline certificate. */
  router.post('/activate', (ctx) => {
    limit(ctx);
    return service.activate(parseActivation(ctx.body), ctx.ip);
  });

  /** Release the binding so the licence can be moved to another machine. */
  router.post('/deactivate', (ctx) => {
    limit(ctx);
    return service.deactivate(parseDeactivation(ctx.body), ctx.ip);
  });

  /**
   * Read-only probe for the licence screen. POST rather than GET so the key
   * never lands in a proxy log or a browser history entry.
   */
  router.post('/status', (ctx) => {
    limit(ctx);
    const source = asObject(ctx.body);
    return service.statusByKey(requireString(source, 'licenseKey', { min: 20, max: 40 }));
  });

  /**
   * Vendor public keys. Published so an installer can pin them out of band;
   * the application ships with its own copy and does not fetch this at runtime.
   */
  router.get('/public-keys', () => ({ keys: service.publicKeys() }));

  /**
   * Who to contact for a licence, and what it costs. Public and unauthenticated
   * because a restaurant in SETUP mode has no licence yet — that is precisely
   * when it needs to know who to call. Nothing here identifies a restaurant, so
   * there is nothing to leak.
   */
  router.get('/vendor-info', (ctx) => {
    limit(ctx);
    return service.vendorInfo();
  });

  return router;
}
