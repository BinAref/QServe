/**
 * Vendor console API (spec §29, §30).
 *
 * Everything the developer can do — search restaurants, issue a licence,
 * release a dead machine, revoke, record a paid transfer — and nothing else.
 * Note what is *absent*: there is no route that returns a restaurant's menu,
 * orders or diners, because this server never receives them.
 */

import {
  asObject, LicenseType, optionalString, requireString,
} from '@qserve/shared';
import { HttpResponse, parseCookies, Router } from '@qserve/http';
import { AdminAuth, clearSessionCookie, SESSION_COOKIE, sessionCookie, type AdminState } from '../auth.js';
import type { LicenseService } from '../service.js';
import { LicenseStore } from '../store.js';

/** Fetch a licence for a response, without its key hash. */
function licenseView(store: LicenseStore, licenseId: string): unknown {
  const license = store.getLicense(licenseId);
  return license ? LicenseStore.publicView(license) : null;
}

export function createAdminApi(
  store: LicenseStore,
  service: LicenseService,
  auth: AdminAuth,
): Router<AdminState> {
  const router = new Router<AdminState>();
  const guard = auth.require();

  /* ------------------------------------------------------------ session */

  router.post('/login', (ctx) => {
    const body = asObject(ctx.body);
    const { token, admin } = auth.login(
      requireString(body, 'username', { max: 80 }),
      requireString(body, 'password', { min: 8, max: 200, trim: false }),
      ctx.ip,
    );
    return new HttpResponse(
      200,
      JSON.stringify({ username: admin.username, displayName: admin.display_name }),
      { 'content-type': 'application/json; charset=utf-8', 'set-cookie': sessionCookie(token) },
    );
  });

  router.post('/logout', (ctx) => {
    auth.logout(parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE]);
    return new HttpResponse(200, JSON.stringify({ ok: true }), {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': clearSessionCookie(),
    });
  });

  router.get('/me', (ctx) => {
    const admin = auth.resolve(ctx);
    return admin
      ? { authenticated: true, username: admin.username, displayName: admin.display_name }
      : { authenticated: false };
  });

  /* -------------------------------------------------------- restaurants */

  router.get('/restaurants', (ctx) => {
    const query = ctx.query.get('query')?.trim() ?? '';
    const rows = query ? store.searchRestaurants(query) : store.listRestaurants();
    return {
      restaurants: rows.map((r) => ({
        ...r,
        licenses: store.listLicensesForRestaurant(r.restaurant_id).length,
      })),
    };
  }, [guard]);

  router.get('/restaurants/:restaurantId', (ctx) => {
    const restaurant = store.getRestaurant(ctx.params['restaurantId']!);
    if (!restaurant) return new HttpResponse(404, JSON.stringify({ error: { code: 'NOT_FOUND' } }));

    return {
      restaurant,
      licenses: store.listLicensesForRestaurant(restaurant.restaurant_id).map((license) => ({
        ...LicenseStore.publicView(license),
        boundDevice: store.liveActivation(license.license_id)?.device_fingerprint ?? null,
      })),
    };
  }, [guard]);

  router.patch('/restaurants/:restaurantId', (ctx) => {
    const body = asObject(ctx.body);
    store.updateRestaurant(ctx.params['restaurantId']!, {
      ...(body['name'] !== undefined ? { name: requireString(body, 'name', { max: 200 }) } : {}),
      ...(body['contactName'] !== undefined
        ? { contact_name: optionalString(body, 'contactName', { max: 120 }) } : {}),
      ...(body['contactPhone'] !== undefined
        ? { contact_phone: optionalString(body, 'contactPhone', { max: 40 }) } : {}),
      ...(body['contactEmail'] !== undefined
        ? { contact_email: optionalString(body, 'contactEmail', { max: 200 }) } : {}),
      ...(body['country'] !== undefined
        ? { country: optionalString(body, 'country', { max: 80 }) } : {}),
      ...(body['notes'] !== undefined
        ? { notes: optionalString(body, 'notes', { max: 2000 }) } : {}),
    });
    store.audit({
      actor: ctx.state.admin!.username,
      action: 'restaurant.updated',
      restaurantId: ctx.params['restaurantId']!,
      clientIp: ctx.ip,
    });
    return store.getRestaurant(ctx.params['restaurantId']!);
  }, [guard]);

  /* ------------------------------------------------------------ licences */

  router.get('/licenses', (ctx) => {
    const query = ctx.query.get('query')?.trim() ?? '';
    const rows = query ? store.searchLicenses(query) : store.searchLicenses('');
    return {
      licenses: rows.map((license) => ({
        ...LicenseStore.publicView(license),
        restaurantName: store.getRestaurant(license.restaurant_id)?.name ?? '',
        boundDevice: store.liveActivation(license.license_id)?.device_fingerprint ?? null,
      })),
    };
  }, [guard]);

  /**
   * Issue a licence. The developer supplies a restaurant name (or an existing
   * Restaurant ID) and nothing else — ids and key material are generated here,
   * never typed by hand (spec §30).
   */
  router.post('/licenses', (ctx) => {
    const body = asObject(ctx.body);
    const restaurantId = optionalString(body, 'restaurantId', { max: 32 });

    const issued = service.issueLicense({
      ...(restaurantId ? { restaurantId } : {}),
      ...(restaurantId ? {} : { restaurantName: requireString(body, 'restaurantName', { max: 200 }) }),
      contactName: optionalString(body, 'contactName', { max: 120 }),
      contactPhone: optionalString(body, 'contactPhone', { max: 40 }),
      contactEmail: optionalString(body, 'contactEmail', { max: 200 }),
      country: optionalString(body, 'country', { max: 80 }),
      notes: optionalString(body, 'notes', { max: 2000 }),
      licenseType: LicenseType.PERPETUAL,
      actor: ctx.state.admin!.username,
      clientIp: ctx.ip,
    });

    return {
      license: LicenseStore.publicView(issued.license),
      restaurant: issued.restaurant,
      // Shown once. The server keeps only a hash and cannot display it again.
      licenseKey: issued.licenseKey,
      warning: 'This key is displayed once. Store it with the customer record now.',
    };
  }, [guard]);

  router.get('/licenses/:licenseId', (ctx) => {
    const licenseId = ctx.params['licenseId']!;
    const license = store.getLicense(licenseId);
    if (!license) return new HttpResponse(404, JSON.stringify({ error: { code: 'NOT_FOUND' } }));

    return {
      license: LicenseStore.publicView(license),
      restaurant: store.getRestaurant(license.restaurant_id),
      liveActivation: store.liveActivation(licenseId) ?? null,
      activations: store.activationHistory(licenseId),
      transfers: store.transferHistory(licenseId),
    };
  }, [guard]);

  /** Release a device that cannot deactivate itself: dead, stolen or sold. */
  router.post('/licenses/:licenseId/release', (ctx) => {
    const body = asObject(ctx.body ?? {});
    service.adminReleaseDevice(
      ctx.params['licenseId']!,
      optionalString(body, 'reason', { max: 200 }) ?? 'released by vendor',
      ctx.state.admin!.username,
      ctx.ip,
    );
    return { ok: true, license: licenseView(store, ctx.params['licenseId']!) };
  }, [guard]);

  router.post('/licenses/:licenseId/revoke', (ctx) => {
    const body = asObject(ctx.body ?? {});
    service.revoke(
      ctx.params['licenseId']!,
      requireString(body, 'reason', { max: 200 }),
      ctx.state.admin!.username,
      ctx.ip,
    );
    return { ok: true, license: licenseView(store, ctx.params['licenseId']!) };
  }, [guard]);

  router.post('/licenses/:licenseId/reinstate', (ctx) => {
    const body = asObject(ctx.body ?? {});
    service.reinstate(
      ctx.params['licenseId']!,
      requireString(body, 'reason', { max: 200 }),
      ctx.state.admin!.username,
      ctx.ip,
    );
    return { ok: true, license: licenseView(store, ctx.params['licenseId']!) };
  }, [guard]);

  /**
   * Record that the transfer fee was settled. This grants exactly one move to a
   * new device; the vendor's own billing system owns the money side.
   */
  router.post('/licenses/:licenseId/transfer-credit', (ctx) => {
    const body = asObject(ctx.body ?? {});
    service.grantTransferCredit(
      ctx.params['licenseId']!,
      optionalString(body, 'feeReference', { max: 120 }),
      ctx.state.admin!.username,
      ctx.ip,
    );
    return { ok: true, license: licenseView(store, ctx.params['licenseId']!) };
  }, [guard]);

  /* ----------------------------------------------------------- audit log */

  router.get('/audit', (ctx) => {
    const limit = Number(ctx.query.get('limit') ?? 100);
    return { entries: store.recentAudit(Math.min(Math.max(limit, 1), 500)) };
  }, [guard]);

  router.get('/signing-keys', () => ({ keys: store.listSigningKeys() }), [guard]);

  /* --------------------------------------------------------- vendor info */

  /**
   * The vendor's own contact details and prices. This is the only place either
   * is written: the application quotes no figure it was not given here, and
   * takes no payment anywhere.
   */
  router.get('/vendor-info', () => service.vendorInfo(), [guard]);

  router.put('/vendor-info', (ctx) =>
    service.saveVendorInfo(ctx.body, ctx.state.admin!.username, ctx.ip), [guard]);

  return router;
}
