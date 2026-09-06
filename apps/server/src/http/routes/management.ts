/**
 * Management console routes: restaurant settings, users and roles, backup and
 * restore, reports, and the licence screen.
 *
 * Everything here is mounted on the loopback listener only. That is not a UI
 * preference — a diner's phone on the restaurant Wi-Fi must not be able to
 * reach a route that can revoke a role or restore a database.
 */

import {
  ALL_PERMISSIONS, asObject, Capability, conflict, DEFAULT_CURRENCY, EventName, isPermission,
  LOCALE_CODE_PATTERN, notFound, optionalBoolean, optionalNumber, optionalString,
  Permission, requireLocalised, requireNumber, requireString, requireStringArray,
  SystemRole, validationError, type CurrencyConfig,
} from '@qserve/shared';
import { HttpResponse, Router } from '@qserve/http';
import type { Services } from '../../container.js';
import type { AppState } from '../../core/security.js';

export function createManagementRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;

  const loopbackOnly = security.adminListenerOnly();
  const canManageSettings = security.requireUser(Permission.SETTINGS_MANAGE);
  const canManageUsers = security.requireUser(Permission.USERS_MANAGE);
  const canManageRoles = security.requireUser(Permission.ROLES_MANAGE);
  const canManageBackup = security.requireUser(Permission.BACKUP_MANAGE);
  const canManageLicense = security.requireUser(Permission.LICENSE_MANAGE);
  const canViewReports = security.requirePermission(Permission.REPORTS_VIEW);
  const canViewAudit = security.requirePermission(Permission.AUDIT_VIEW);

  /* ------------------------------------------------------------ profile */

  router.get('/restaurant', () => {
    const profile = services.settings.profile();
    if (!profile) throw notFound('restaurant');
    return profile;
  }, [loopbackOnly, security.requirePermission(Permission.SETTINGS_MANAGE)]);

  router.patch('/restaurant', (ctx) => {
    const body = asObject(ctx.body);
    const before = services.settings.profile();
    if (!before) throw notFound('restaurant');

    const enabledLocales = body['enabledLocales'] !== undefined
      ? requireStringArray(body, 'enabledLocales', { min: 1, max: 40 })
      : null;
    if (enabledLocales) {
      for (const locale of enabledLocales) {
        if (!services.translations.has(locale)) {
          throw validationError(`language "${locale}" is not installed`, { field: 'enabledLocales' });
        }
      }
    }

    const themeId = optionalString(body, 'themeId', { max: 32 });
    if (themeId && !services.themes.has(themeId)) {
      throw validationError('that theme is not installed', { field: 'themeId' });
    }

    const defaultLocale = optionalString(body, 'defaultLocale', {
      pattern: LOCALE_CODE_PATTERN, max: 12,
    });
    if (defaultLocale && !services.translations.has(defaultLocale)) {
      throw validationError('that language is not installed', { field: 'defaultLocale' });
    }

    services.settings.updateRestaurant({
      ...(body['name'] !== undefined ? { name: requireLocalised(body, 'name', { max: 200 }) } : {}),
      ...(body['legalName'] !== undefined
        ? { legalName: optionalString(body, 'legalName', { max: 200 }) } : {}),
      ...(body['logoAssetId'] !== undefined
        ? { logoAssetId: optionalString(body, 'logoAssetId', { max: 64 }) } : {}),
      ...(body['address'] !== undefined
        ? { address: optionalString(body, 'address', { max: 400 }) } : {}),
      ...(body['phone'] !== undefined ? { phone: optionalString(body, 'phone', { max: 40 }) } : {}),
      ...(body['email'] !== undefined ? { email: optionalString(body, 'email', { max: 200 }) } : {}),
      ...(body['taxNumber'] !== undefined
        ? { taxNumber: optionalString(body, 'taxNumber', { max: 60 }) } : {}),
      ...(body['currency'] !== undefined
        ? { currency: parseCurrency(asObject(body['currency'], 'currency')) } : {}),
      ...(body['taxRatePercent'] !== undefined
        ? { taxRatePercent: requireNumber(body, 'taxRatePercent', { min: 0, max: 100, integer: false }) } : {}),
      ...(body['taxInclusive'] !== undefined
        ? { taxInclusive: optionalBoolean(body, 'taxInclusive', false) } : {}),
      ...(body['serviceRatePercent'] !== undefined
        ? { serviceRatePercent: requireNumber(body, 'serviceRatePercent', { min: 0, max: 100, integer: false }) } : {}),
      ...(defaultLocale ? { defaultLocale } : {}),
      ...(enabledLocales ? { enabledLocales } : {}),
      ...(themeId ? { themeId } : {}),
    });

    services.audit.record({
      action: 'restaurant.updated',
      actor: ctx.state.auth!.actor,
      entityType: 'restaurant',
      entityId: before.restaurantId,
      before,
      after: services.settings.profile(),
      clientIp: ctx.ip,
    });

    return services.settings.profile();
  }, [loopbackOnly, canManageSettings]);

  /* ----------------------------------------------------------- settings */

  router.get('/settings', () => ({ settings: services.settings.all() }),
    [loopbackOnly, security.requirePermission(Permission.SETTINGS_MANAGE)]);

  router.patch('/settings', (ctx) => {
    const body = asObject(ctx.body);
    const before = services.settings.all();

    for (const [key, value] of Object.entries(body)) {
      if (!(key in before)) {
        throw validationError(`unknown setting "${key}"`, { field: key });
      }
      services.settings.set(key, value);
    }

    services.audit.record({
      action: 'settings.updated',
      actor: ctx.state.auth!.actor,
      entityType: 'settings',
      detail: { keys: Object.keys(body) },
      clientIp: ctx.ip,
    });

    services.bus.publish({
      name: EventName.SYSTEM_SETTINGS_CHANGED,
      payload: { keys: Object.keys(body) },
    });

    return { settings: services.settings.all() };
  }, [loopbackOnly, canManageSettings]);

  /* -------------------------------------------------------------- users */

  router.get('/users', () => ({
    users: services.access.listUsers().map(({ user, roleKeys }) => ({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      roleKeys,
      active: user.active === 1,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
    })),
  }), [loopbackOnly, security.requirePermission(Permission.USERS_MANAGE)]);

  router.post('/users', (ctx) => {
    const body = asObject(ctx.body);
    const username = requireString(body, 'username', {
      min: 3, max: 40, pattern: /^[a-zA-Z0-9._-]+$/,
    });
    if (services.access.getUserByUsername(username)) {
      throw conflict('that username is already taken', { username });
    }

    const roleKeys = requireStringArray(body, 'roleKeys', { min: 1, max: 10 });
    for (const key of roleKeys) {
      if (!services.access.getRoleByKey(key)) throw notFound('role', key);
    }

    const user = services.access.createUser({
      username,
      displayName: requireString(body, 'displayName', { max: 80 }),
      // A four-digit PIN is normal on a restaurant tablet; the minimum is low
      // deliberately, and the login route is rate limited to compensate.
      secret: requireString(body, 'password', { min: 4, max: 200, trim: false }),
      roleKeys,
    });

    services.audit.record({
      action: 'user.created',
      actor: ctx.state.auth!.actor,
      entityType: 'user',
      entityId: user.id,
      after: { username, roleKeys },
      clientIp: ctx.ip,
    });

    return { id: user.id, username: user.username, displayName: user.display_name, roleKeys };
  }, [loopbackOnly, canManageUsers]);

  router.patch('/users/:id', (ctx) => {
    const id = ctx.params['id']!;
    const user = services.access.getUser(id);
    if (!user) throw notFound('user', id);
    const body = asObject(ctx.body);

    const active = body['active'] !== undefined ? optionalBoolean(body, 'active', true) : undefined;

    services.access.updateUser(id, {
      ...(body['displayName'] !== undefined
        ? { displayName: requireString(body, 'displayName', { max: 80 }) } : {}),
      ...(body['password'] !== undefined
        ? { secret: requireString(body, 'password', { min: 4, max: 200, trim: false }) } : {}),
      ...(active !== undefined ? { active } : {}),
    });

    if (body['roleKeys'] !== undefined) {
      services.access.setUserRoles(id, requireStringArray(body, 'roleKeys', { min: 1, max: 10 }));
    }
    // Disabling an account or changing its password must end its live sessions
    // immediately, not whenever the tablet is next closed.
    if (active === false || body['password'] !== undefined) {
      services.access.deleteSessionsForUser(id);
    }

    services.audit.record({
      action: 'user.updated',
      actor: ctx.state.auth!.actor,
      entityType: 'user',
      entityId: id,
      detail: { fields: Object.keys(body) },
      clientIp: ctx.ip,
    });

    return { ok: true };
  }, [loopbackOnly, canManageUsers]);

  router.delete('/users/:id', (ctx) => {
    const id = ctx.params['id']!;
    const user = services.access.getUser(id);
    if (!user) throw notFound('user', id);

    // Refuse to remove the last administrator: an installation with no way in
    // would need a database edit to recover.
    const admins = services.access.listUsers()
      .filter((entry) => entry.roleKeys.includes(SystemRole.ADMIN) && entry.user.active === 1);
    if (admins.length <= 1 && admins[0]?.user.id === id) {
      throw conflict('this is the only administrator account');
    }

    services.access.deleteUser(id);
    services.audit.record({
      action: 'user.deleted',
      actor: ctx.state.auth!.actor,
      entityType: 'user',
      entityId: id,
      before: { username: user.username },
      clientIp: ctx.ip,
    });
    return { deleted: id };
  }, [loopbackOnly, canManageUsers]);

  /* -------------------------------------------------------------- roles */

  router.get('/roles', () => ({
    roles: services.access.listRoles().map(({ row, permissions }) => ({
      id: row.id,
      key: row.key,
      name: services.access.roleName(row),
      system: row.is_system === 1,
      permissions,
    })),
    availablePermissions: ALL_PERMISSIONS,
  }), [loopbackOnly, security.requirePermission(Permission.ROLES_MANAGE)]);

  router.post('/roles', (ctx) => {
    const body = asObject(ctx.body);
    const key = requireString(body, 'key', { max: 40, pattern: /^[A-Z][A-Z0-9_]*$/ });
    if (services.access.getRoleByKey(key)) throw conflict('that role key already exists', { key });

    const permissions = requireStringArray(body, 'permissions', { max: 80 });
    for (const permission of permissions) {
      if (!isPermission(permission) && permission !== '*' && !permission.endsWith('.*')) {
        throw validationError(`unknown permission "${permission}"`, { field: 'permissions' });
      }
    }

    const role = services.access.createRole(
      key, requireLocalised(body, 'name', { max: 80 }), permissions,
    );
    services.audit.record({
      action: 'role.created',
      actor: ctx.state.auth!.actor,
      entityType: 'role',
      entityId: role.id,
      after: { key, permissions },
      clientIp: ctx.ip,
    });
    return { id: role.id, key: role.key };
  }, [loopbackOnly, canManageRoles]);

  router.put('/roles/:id/permissions', (ctx) => {
    const id = ctx.params['id']!;
    const role = services.access.getRoleById(id);
    if (!role) throw notFound('role', id);

    const body = asObject(ctx.body);
    const permissions = requireStringArray(body, 'permissions', { max: 80 });
    for (const permission of permissions) {
      if (!isPermission(permission) && permission !== '*' && !permission.endsWith('.*')) {
        throw validationError(`unknown permission "${permission}"`, { field: 'permissions' });
      }
    }

    const before = services.access.permissionsForRole(id);
    services.access.setRolePermissions(id, permissions);

    services.audit.record({
      action: 'role.permissions_changed',
      actor: ctx.state.auth!.actor,
      entityType: 'role',
      entityId: id,
      before: { permissions: before },
      after: { permissions },
      clientIp: ctx.ip,
    });
    return { ok: true, permissions };
  }, [loopbackOnly, canManageRoles]);

  router.delete('/roles/:id', (ctx) => {
    const role = services.access.getRoleById(ctx.params['id']!);
    if (!role) throw notFound('role', ctx.params['id']!);
    if (role.is_system === 1) throw conflict('built-in roles cannot be deleted');

    services.access.deleteRole(role.id);
    return { deleted: role.id };
  }, [loopbackOnly, canManageRoles]);

  /* ------------------------------------------------------------- backup */

  router.get('/backups', async () => ({ backups: await services.backup.list() }),
    [loopbackOnly, security.requirePermission(Permission.BACKUP_MANAGE)]);

  router.post('/backups', async (ctx) => {
    const body = asObject(ctx.body);
    return services.backup.create({
      passphrase: requireString(body, 'passphrase', { min: 8, max: 200, trim: false }),
      note: optionalString(body, 'note', { max: 300 }),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [loopbackOnly, canManageBackup]);

  /** Download an encrypted backup file. */
  router.get('/backups/:fileName/download', async (ctx) => {
    const fileName = ctx.params['fileName']!;
    const bytes = await services.backup.read(fileName);
    return new HttpResponse(200, bytes, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${fileName}"`,
      'content-length': String(bytes.length),
    });
  }, [loopbackOnly, security.requirePermission(Permission.BACKUP_MANAGE)]);

  /** Header-only inspection before an operator commits to restoring. */
  router.post('/backups/inspect', async (ctx) => {
    const file = ctx.body;
    if (!Buffer.isBuffer(file)) {
      throw validationError('send the backup file as application/octet-stream');
    }
    return services.backup.inspect(file);
  }, [loopbackOnly, security.requirePermission(Permission.BACKUP_MANAGE)]);

  /**
   * Restore. Destructive by definition, so it is loopback-only, requires an
   * identified user with `backup.manage`, and needs the caller to repeat the
   * restaurant id shown by `/backups/inspect`.
   */
  router.post('/backups/restore', async (ctx) => {
    const file = ctx.body;
    if (!Buffer.isBuffer(file)) {
      throw validationError('send the backup file as application/octet-stream');
    }
    const passphrase = ctx.query.get('passphrase');
    if (!passphrase) throw validationError('a passphrase is required', { field: 'passphrase' });

    const confirm = ctx.query.get('confirmRestaurantId');
    const header = await services.backup.inspect(file);
    if (confirm !== header['restaurantId']) {
      throw conflict(
        'confirmRestaurantId must match the restaurant id inside the backup',
        { expected: header['restaurantId'] },
      );
    }

    const result = await services.backup.restore({
      file,
      passphrase,
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });

    // The restored data may name a different restaurant, so the licence has to
    // be re-checked against it. A backup from another machine leaves the
    // installation in SETUP until it is activated here (spec §6).
    services.gate.evaluate(services.settings.profile()?.restaurantId as never);
    return result;
  }, [loopbackOnly, canManageBackup]);

  /* ------------------------------------------------------------ reports */

  router.get('/reports/sales', (ctx) => {
    const range = services.reports.rangeFor(ctx.query.get('since'), ctx.query.get('until'));
    const report = services.reports.sales(range);

    if (ctx.query.get('format') === 'csv') {
      const locale = ctx.query.get('locale') ?? services.settings.profile()?.defaultLocale ?? 'en';
      return new HttpResponse(200, services.reports.toCsv(report, locale), {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="qserve-sales-${range.label}.csv"`,
      });
    }
    return report;
  }, [security.requireCapability(Capability.REPORTS_RUNTIME), canViewReports]);

  router.get('/reports/shift', (ctx) => {
    const range = services.reports.rangeFor(ctx.query.get('since'), ctx.query.get('until'));
    const userId = ctx.query.get('userId') ?? ctx.state.auth?.user?.id;
    if (!userId) throw validationError('userId is required', { field: 'userId' });
    return services.reports.cashierShift(range, userId);
  }, [security.requireCapability(Capability.REPORTS_RUNTIME), canViewReports]);

  router.get('/audit', (ctx) => ({
    entries: services.audit.query({
      ...(ctx.query.get('orderId') ? { orderId: ctx.query.get('orderId')! } : {}),
      ...(ctx.query.get('entityType') ? { entityType: ctx.query.get('entityType')! } : {}),
      ...(ctx.query.get('action') ? { action: ctx.query.get('action')! } : {}),
      ...(ctx.query.get('since') ? { since: ctx.query.get('since')! } : {}),
      limit: Number(ctx.query.get('limit') ?? 200),
    }),
  }), [canViewAudit]);

  /* ------------------------------------------------------------ licence */

  router.get('/license', () => services.licensing.localStatus(),
    [loopbackOnly, security.requirePermission(Permission.LICENSE_MANAGE)]);

  router.get('/license/request-message', () => services.licensing.licenceRequestMessage(
    services.config.vendorWhatsApp,
  ), [loopbackOnly, security.requirePermission(Permission.LICENSE_MANAGE)]);

  router.post('/license/activate', async (ctx) => {
    const body = asObject(ctx.body);
    return services.licensing.activate({
      licenseKey: requireString(body, 'licenseKey', { min: 20, max: 40 }),
      rememberKey: optionalBoolean(body, 'rememberKey', true),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [loopbackOnly, canManageLicense]);

  router.post('/license/deactivate', async (ctx) => {
    const body = asObject(ctx.body ?? {});
    return services.licensing.deactivate({
      ...(body['licenseKey'] !== undefined
        ? { licenseKey: requireString(body, 'licenseKey', { min: 20, max: 40 }) } : {}),
      reason: optionalString(body, 'reason', { max: 200 }) ?? 'moving to another device',
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [loopbackOnly, canManageLicense]);

  /** Manual probe of the vendor's record. Never called automatically. */
  router.post('/license/check', async (ctx) => {
    const body = asObject(ctx.body ?? {});
    return services.licensing.remoteStatus(
      body['licenseKey'] !== undefined
        ? requireString(body, 'licenseKey', { min: 20, max: 40 })
        : undefined,
    );
  }, [loopbackOnly, canManageLicense]);

  /** Re-run the offline certificate check, e.g. after swapping hardware. */
  router.post('/license/reevaluate', () => {
    const snapshot = services.gate.evaluate(services.settings.profile()?.restaurantId as never);
    return {
      mode: snapshot.mode,
      verdict: snapshot.verdict,
      explanation: services.gate.explain(),
      capabilities: snapshot.capabilities,
    };
  }, [loopbackOnly, canManageLicense]);

  return router;
}

function parseCurrency(body: Record<string, unknown>): CurrencyConfig {
  const symbolPosition = optionalString(body, 'symbolPosition', { max: 6 }) ?? 'after';
  if (symbolPosition !== 'before' && symbolPosition !== 'after') {
    throw validationError('symbolPosition must be "before" or "after"', {
      field: 'currency.symbolPosition',
    });
  }
  return {
    code: requireString(body, 'code', { min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
    symbol: requireString(body, 'symbol', { max: 8 }),
    decimals: optionalNumber(body, 'decimals', { min: 0, max: 4 }) ?? DEFAULT_CURRENCY.decimals,
    symbolPosition,
  };
}
