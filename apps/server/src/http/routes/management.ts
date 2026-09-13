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
import { BackupScope } from '../../modules/backup/service.js';
import { SECRET_PLACEHOLDER, SECRET_SETTING_KEYS } from '../../core/repositories/settings.js';

/**
 * The passphrase that opens a backup, taken from a header.
 *
 * The body of these two requests is the backup file itself, so the passphrase
 * has to travel beside it — and it used to travel in the query string, where
 * it lands in the request line. Request lines are the most casually logged
 * thing in computing: proxies keep them, servers keep them, crash reporters
 * keep them. This one unlocks a file containing the restaurant's entire
 * database, so it belongs in a header, which nothing logs by default.
 */
function backupPassphrase(ctx: { req: { headers: Record<string, unknown> } }): string {
  const raw = ctx.req.headers['x-backup-passphrase'];
  const passphrase = Array.isArray(raw) ? raw[0] : raw;
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw validationError('a passphrase is required', { field: 'passphrase' });
  }
  return passphrase;
}

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

    // The profile's currency and the base currency row are two views of one
    // fact; editing one without the other would leave the menu priced against
    // something the restaurant no longer uses.
    const updated = services.settings.profile()!;
    services.currencies.seedBase(updated.currency);

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

  router.get('/settings', () => ({ settings: services.settings.publicAll() }),
    [loopbackOnly, security.requirePermission(Permission.SETTINGS_MANAGE)]);

  router.patch('/settings', (ctx) => {
    const body = asObject(ctx.body);
    const before = services.settings.all();
    const written: string[] = [];

    for (const [key, value] of Object.entries(body)) {
      if (!(key in before)) {
        throw validationError(`unknown setting "${key}"`, { field: key });
      }
      // The console never receives a secret's value, so it cannot send one
      // back. Echoing the placeholder means "unchanged"; the app lock has its
      // own endpoint for actually setting one.
      if (SECRET_SETTING_KEYS.includes(key) && value === SECRET_PLACEHOLDER) continue;
      if (key === 'security.appLockHash' || key === 'security.appLockEnabled') {
        throw validationError('the app lock is changed from the lock screen', { field: key });
      }
      services.settings.set(key, value);
      written.push(key);
    }

    services.audit.record({
      action: 'settings.updated',
      actor: ctx.state.auth!.actor,
      entityType: 'settings',
      detail: { keys: written },
      clientIp: ctx.ip,
    });

    services.bus.publish({
      name: EventName.SYSTEM_SETTINGS_CHANGED,
      payload: { keys: written },
    });

    return { settings: services.settings.publicAll() };
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
      // Empty when nobody has renamed it: the console then shows the shipped
      // label, translated into whatever language the reader is using.
      name: services.access.roleName(row),
      system: row.is_system === 1,
      permissions,
    })),
    availablePermissions: ALL_PERMISSIONS,
  }), [loopbackOnly, security.requirePermission(Permission.ROLES_MANAGE)]);

  /**
   * Rename a role — including a built-in one. What a restaurant calls its
   * people is the restaurant's business; what those people may do is not, so
   * this route touches `name` and nothing else. Sending `null` gives the role
   * its shipped label back.
   */
  router.patch('/roles/:id', (ctx) => {
    const id = ctx.params['id']!;
    const role = services.access.getRoleById(id);
    if (!role) throw notFound('role', id);

    const body = asObject(ctx.body);
    const before = services.access.roleName(role);
    const name = body['name'] === null ? {} : requireLocalised(body, 'name', { max: 80 });
    services.access.renameRole(id, name);

    services.audit.record({
      action: 'role.renamed',
      actor: ctx.state.auth!.actor,
      entityType: 'role',
      entityId: id,
      before: { name: before },
      after: { name },
      clientIp: ctx.ip,
    });
    // Every screen reads the name from its session, so they all need telling.
    services.bus.publish({ name: EventName.SYSTEM_SETTINGS_CHANGED, payload: { keys: ['roles'] } });
    return { id, key: role.key, name };
  }, [loopbackOnly, canManageRoles]);

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
    // A built-in role's grants are the product's promise, not a setting: a
    // "cashier" means the same thing in every restaurant that runs QServe, even
    // where the word on the badge is different. A restaurant that needs another
    // set of powers adds a role of its own, which it then owns outright.
    if (role.is_system === 1) {
      throw conflict('a built-in role keeps the permissions the system gives it', {
        role: role.key, hint: 'rename it, or add a role of your own',
      });
    }

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
    services.audit.record({
      action: 'role.deleted',
      actor: ctx.state.auth!.actor,
      entityType: 'role',
      entityId: role.id,
      before: { key: role.key, name: role.name_json },
      clientIp: ctx.ip,
    });
    return { deleted: role.id };
  }, [loopbackOnly, canManageRoles]);

  /* ------------------------------------------------------------- backup */

  router.get('/backups', async () => ({ backups: await services.backup.list() }),
    [loopbackOnly, security.requirePermission(Permission.BACKUP_MANAGE)]);

  /*
   * Which backups this installation may take.
   *
   * The menu alone, always — building the menu is what a restaurant does
   * first, and losing it to a reinstall before the licence arrives would be
   * the worst hour of its week. Everything, once it has been activated: the
   * rest of the data only starts to exist then. It stays available after a
   * licence is cancelled, because that is exactly when somebody needs their
   * data out.
   */
  router.get('/backups/scopes', () => ({
    menu: true,
    full: services.settings.get<boolean>('setup.everActivated') === true,
  }), [loopbackOnly, canManageBackup]);

  router.post('/backups', async (ctx) => {
    const body = asObject(ctx.body);
    const scope = optionalString(body, 'scope', { max: 8 }) === BackupScope.MENU
      ? BackupScope.MENU
      : BackupScope.FULL;

    /*
     * Asking for everything before this installation has ever been activated
     * would produce a file of empty tables and call it a backup of the
     * restaurant. The menu is what exists at that point, so that is what can
     * be taken.
     */
    if (scope === BackupScope.FULL
        && services.settings.get<boolean>('setup.everActivated') !== true) {
      throw conflict('a full backup is available once this installation has been activated');
    }

    return services.backup.create({
      passphrase: requireString(body, 'passphrase', { min: 8, max: 200, trim: false }),
      note: optionalString(body, 'note', { max: 300 }),
      scope,
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
  /**
   * What is in this file, and what it would replace — without doing it.
   *
   * The last thing between a person and losing what they have. `inspect` reads
   * the unencrypted header; this opens the file properly and counts, so the
   * confirmation can say "24 dishes and 61 photographs will replace the 12
   * dishes here" instead of "are you sure".
   */
  router.post('/backups/preview', async (ctx) => {
    const file = ctx.body;
    if (!Buffer.isBuffer(file)) {
      throw validationError('send the backup file as application/octet-stream');
    }
    return services.backup.preview(file, backupPassphrase(ctx));
  }, [loopbackOnly, canManageBackup]);

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
    const passphrase = backupPassphrase(ctx);

    /*
     * The friction, aimed at the case that deserves it.
     *
     * This used to make the operator retype the Restaurant ID printed inside
     * the file, on every restore. That is the wrong tax: restoring your own
     * backup onto your own machine is the ordinary case and was the one being
     * punished, while the dangerous case — somebody else's file, or another
     * branch's — got exactly the same speed bump and no warning that it was
     * different.
     *
     * The console now opens the file first and shows what is in it and whose
     * it is, which is a better safeguard than copying a code across. What is
     * left here is the question worth asking: if this file belongs to another
     * restaurant, say so deliberately.
     */
    const header = await services.backup.inspect(file);
    const here = services.settings.profile()?.restaurantId ?? null;
    const fromElsewhere = here !== null && header['restaurantId'] !== here;

    if (fromElsewhere && ctx.query.get('acceptDifferentRestaurant') !== 'true') {
      throw conflict(
        'this backup belongs to a different restaurant',
        { thisRestaurant: here, backupRestaurant: header['restaurantId'] },
      );
    }

    /*
     * `?groups=menu,images` — what the person ticked. Absent means everything
     * in the file, which is what "restore this backup" has always meant.
     */
    const groups = (ctx.query.get('groups') ?? '')
      .split(',').map((name) => name.trim()).filter(Boolean);

    const result = await services.backup.restore({
      file,
      passphrase,
      ...(groups.length > 0 ? { groups } : {}),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });

    // The restored data may name a different restaurant, so the licence has to
    // be re-checked against it. A backup from another machine leaves the
    // installation in SETUP until it is activated here (spec §6).
    services.gate.evaluate(services.settings.profile()?.restaurantId as never);

    // Written after the restore, not before: the restore replaces the settings
    // table wholesale. Bringing a menu in is one of the two answers to the
    // first-run question, so the question is now settled.
    services.settings.set('setup.menuStarted', true);
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

  /**
   * The activity log (spec §19).
   *
   * Everything every person and every station did, filterable by who, what,
   * which station and when, and paged rather than truncated — a log an owner
   * can only read the last 200 lines of is not a log they can rely on.
   */
  router.get('/audit', (ctx) => {
    const filters = {
      ...(ctx.query.get('orderId') ? { orderId: ctx.query.get('orderId')! } : {}),
      ...(ctx.query.get('entityType') ? { entityType: ctx.query.get('entityType')! } : {}),
      ...(ctx.query.get('entityId') ? { entityId: ctx.query.get('entityId')! } : {}),
      ...(ctx.query.get('action') ? { action: ctx.query.get('action')! } : {}),
      ...(ctx.query.get('actorUserId') ? { actorUserId: ctx.query.get('actorUserId')! } : {}),
      ...(ctx.query.get('actorKind') ? { actorKind: ctx.query.get('actorKind')! } : {}),
      ...(ctx.query.get('terminalId') ? { terminalId: ctx.query.get('terminalId')! } : {}),
      ...(ctx.query.get('search') ? { search: ctx.query.get('search')! } : {}),
      ...(ctx.query.get('since') ? { since: ctx.query.get('since')! } : {}),
      ...(ctx.query.get('until') ? { until: ctx.query.get('until')! } : {}),
    };
    const limit = Math.min(Math.max(Number(ctx.query.get('limit') ?? 100), 1), 500);
    const offset = Math.max(Number(ctx.query.get('offset') ?? 0), 0);

    return {
      entries: services.audit.query({ ...filters, limit, offset }),
      total: services.audit.count(filters),
      limit,
      offset,
    };
  }, [canViewAudit]);

  /** The values present in the log, so the filters offer only what exists. */
  router.get('/audit/facets', () => services.audit.facets(), [canViewAudit]);

  /* ------------------------------------------------------------ licence */

  router.get('/license', () => services.licensing.localStatus(),
    [loopbackOnly, security.requirePermission(Permission.LICENSE_MANAGE)]);

  /**
   * Who to contact about a licence and what it costs — the vendor's own words,
   * fetched once and cached. The application handles no payment: buying a
   * licence is a conversation with the vendor, and this is the phone number.
   */
  router.get('/license/vendor', () => services.licensing.vendorInfo(),
    [loopbackOnly, security.requirePermission(Permission.LICENSE_MANAGE)]);

  /** Re-fetch the vendor's contact details and prices. Explicit, never automatic. */
  router.post('/license/vendor/refresh', async () => services.licensing.refreshVendorInfo(),
    [loopbackOnly, canManageLicense]);

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
