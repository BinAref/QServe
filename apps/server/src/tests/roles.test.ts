/**
 * A role has two halves, and they belong to different people.
 *
 * The **name** is the restaurant's. One owner's waiter is another's host, and
 * whichever word they choose has to reach every screen — the floor tablet's
 * heading, the station list, the button a diner presses to call someone.
 *
 * The **permissions** of a built-in role are the system's. A cashier means the
 * same thing in every restaurant that runs QServe, whatever the badge says, so
 * an owner cannot hand the till's powers to the room by editing a checkbox. A
 * restaurant that needs a different set of powers adds a role of its own, and
 * owns that one outright.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestContext } from '@qserve/http';
import {
  DEFAULT_ROLE_PERMISSIONS, Permission, SystemRole, WILDCARD_PERMISSION,
} from '@qserve/shared';

import { createManagementRoutes } from '../http/routes/management.js';
import type { AppState } from '../core/security.js';
import { createInstallation, seedRestaurant, seedUser, type Installation } from './harness.js';

let installation: Installation;

/**
 * Call a management route the way the server would, minus the middleware that
 * would demand loopback and a signed-in administrator. The rule under test is
 * the handler's, and this keeps the test on it.
 */
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const router = createManagementRoutes(installation.services);
  const match = router.resolve(method, path);
  assert.ok(match, `no route for ${method} ${path}`);

  const ctx = {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    method,
    path,
    query: new URLSearchParams(),
    params: match.params,
    body,
    ip: '127.0.0.1',
    listener: 'admin' as const,
    state: { auth: { actor: installation.systemActor } } as unknown as AppState,
  } satisfies RequestContext<AppState>;

  return match.handler(ctx);
}

const roleNamed = async (key: string): Promise<{ id: string; name: Record<string, string> }> => {
  const { roles } = await call('GET', '/roles') as {
    roles: { id: string; key: string; name: Record<string, string> }[];
  };
  const role = roles.find((entry) => entry.key === key);
  assert.ok(role, `no role ${key}`);
  return role;
};

describe('the restaurant names its roles', () => {
  before(() => {
    installation = createInstallation();
    seedRestaurant(installation);
  });
  after(() => installation.dispose());

  test('a built-in role starts unnamed, so every language reads correctly', async () => {
    const waiter = await roleNamed(SystemRole.WAITER);
    assert.deepEqual(waiter.name, {},
      'a seeded role must carry no name: the shipped translation is the label');
    assert.deepEqual(installation.services.access.roleNames(), {},
      'nothing has been renamed, so no screen should be told otherwise');
  });

  test('renaming reaches every screen, and never touches a grant', async () => {
    const waiter = await roleNamed(SystemRole.WAITER);
    const before = installation.services.access.permissionsForRole(waiter.id);

    await call('PATCH', `/roles/${waiter.id}`, { name: { en: 'Host', ar: 'مضيف' } });

    assert.deepEqual(installation.services.access.roleNames()[SystemRole.WAITER],
      { en: 'Host', ar: 'مضيف' });
    assert.deepEqual(installation.services.access.permissionsForRole(waiter.id), before,
      'a rename is a rename');

    // The word an owner types is theirs, and the activity log says who typed it.
    const entries = installation.services.audit.query({ limit: 10 });
    assert.ok(entries.some((entry) => entry.action === 'role.renamed'));
  });

  test('a rename can be undone, handing the label back to the language pack', async () => {
    const waiter = await roleNamed(SystemRole.WAITER);
    await call('PATCH', `/roles/${waiter.id}`, { name: null });
    assert.equal(installation.services.access.roleNames()[SystemRole.WAITER], undefined);
  });

  test('a built-in role keeps the permissions the system gives it', async () => {
    const cashier = await roleNamed(SystemRole.CASHIER);

    await assert.rejects(
      () => call('PUT', `/roles/${cashier.id}/permissions`, {
        permissions: [WILDCARD_PERMISSION],
      }),
      (error: { code?: string }) => error.code === 'CONFLICT',
      'the till\'s powers are not a setting',
    );

    assert.deepEqual(
      [...installation.services.access.permissionsForRole(cashier.id)].sort(),
      [...DEFAULT_ROLE_PERMISSIONS[SystemRole.CASHIER]].sort(),
    );
  });

  test('a restaurant that needs other powers adds a role, and owns it', async () => {
    const created = await call('POST', '/roles', {
      key: 'BARISTA',
      name: { en: 'Barista' },
      permissions: [Permission.ORDERS_VIEW, Permission.ORDERS_CHANGE_STATUS],
    }) as { id: string };

    await call('PUT', `/roles/${created.id}/permissions`, {
      permissions: [Permission.ORDERS_VIEW, Permission.PAYMENTS_CREATE],
    });
    assert.deepEqual(
      [...installation.services.access.permissionsForRole(created.id)].sort(),
      [Permission.ORDERS_VIEW, Permission.PAYMENTS_CREATE].sort(),
    );

    // And a person holding it gets exactly that, no more.
    const barista = seedUser(installation, 'sam', 'Sam', ['BARISTA']);
    assert.deepEqual(
      [...installation.services.access.permissionsForUser(barista.id)].sort(),
      [Permission.ORDERS_VIEW, Permission.PAYMENTS_CREATE].sort(),
    );

    await call('DELETE', `/roles/${created.id}`);
    assert.equal(installation.services.access.getRoleByKey('BARISTA'), undefined);
  });

  test('drifted grants are put back at boot', () => {
    const access = installation.services.access;
    const kitchen = access.getRoleByKey(SystemRole.KITCHEN)!;

    // However it happened — an older version, a restored backup, a hand-edited
    // database — the next boot is where it stops being true.
    access.setRolePermissions(kitchen.id, [WILDCARD_PERMISSION]);

    const repaired = access.assertSystemGrants(DEFAULT_ROLE_PERMISSIONS);
    assert.deepEqual(repaired, [SystemRole.KITCHEN]);
    assert.deepEqual(
      [...access.permissionsForRole(kitchen.id)].sort(),
      [...DEFAULT_ROLE_PERMISSIONS[SystemRole.KITCHEN]].sort(),
    );
    assert.deepEqual(access.assertSystemGrants(DEFAULT_ROLE_PERMISSIONS), [],
      'a boot with nothing wrong changes nothing');
  });

  test('a role the restaurant added is left alone by the boot repair', () => {
    const access = installation.services.access;
    const role = access.createRole('RUNNER', { en: 'Runner' }, [Permission.ORDERS_VIEW]);
    assert.deepEqual(access.assertSystemGrants(DEFAULT_ROLE_PERMISSIONS), []);
    assert.deepEqual(access.permissionsForRole(role.id), [Permission.ORDERS_VIEW]);
  });
});
