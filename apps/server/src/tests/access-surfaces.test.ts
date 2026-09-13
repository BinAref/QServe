/**
 * What each listener is allowed to carry.
 *
 * The restaurant's data lives on the restaurant's computer, and three
 * different audiences reach it over three different routes. The difference
 * between them is the whole of the product's security model, and it is
 * enforced by which router a route was registered on — a decision made once,
 * in passing, by whoever added the route.
 *
 * That is a bad place for a security boundary to live unwatched. This walks
 * each surface and checks it against what `SURFACE_RULES` says it may do, so
 * mounting a management route on the network listener fails here rather than
 * being discovered from outside.
 *
 * The public surface matters most and is not served in this release. Remote
 * access is a later subscription, and the temptation when it arrives will be to
 * point a tunnel at the network listener because it already serves the menu.
 * That listener also takes orders, enrols terminals and serves the staff
 * applications. This test is what makes the difference visible in advance.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createPublicMenuRouter, SURFACE_RULES } from '../http/access.js';
import { createInstallation, type Installation } from './harness.js';

let installation: Installation;

before(() => { installation = createInstallation(); });
after(() => installation.dispose());

describe('the public menu surface', () => {

  test('reads, and nothing else', () => {
    const routes = createPublicMenuRouter(installation.services).list();
    const writes = routes.filter((route) => route.method !== 'GET');

    assert.deepEqual(writes, [],
      `a surface facing the open internet must not have a route that changes anything; found ${
        writes.map((w) => `${w.method} ${w.path}`).join(', ')}`);
    assert.ok(routes.length > 0, 'and it must actually serve the menu');
  });

  test('carries the menu and its photographs, and no management', () => {
    const paths = createPublicMenuRouter(installation.services).list().map((r) => r.path);

    assert.ok(paths.includes('/api/menu'), 'the menu itself');
    assert.ok(paths.some((path) => path.startsWith('/assets')), 'the images the menu shows');

    /*
     * The names below are the ones that would matter if this were ever exposed.
     * Ordering is deliberately in the list: a menu a stranger on the internet
     * can order from is a menu a stranger on the internet can send food to a
     * table with.
     */
    for (const forbidden of ['/api/orders', '/api/settings', '/api/users', '/api/backups',
      '/api/license', '/api/terminals', '/api/tables', '/api/dev']) {
      assert.equal(paths.some((path) => path.startsWith(forbidden)), false,
        `${forbidden} must not be reachable from the public surface`);
    }
  });

  test('is declared as not served in this release', () => {
    // The rule and the reality have to agree: if somebody starts serving it,
    // they have to come here and say so.
    assert.equal(SURFACE_RULES.PUBLIC.servedInThisRelease, false);
    assert.equal(SURFACE_RULES.PUBLIC.allowsWrites, false);
    assert.equal(SURFACE_RULES.PUBLIC.allowsManagement, false);
  });
});

describe('remote access is bookkeeping, never a dependency', () => {

  test('a restaurant with no remote subscription is unaffected', () => {
    const { settings } = installation.services;

    // Nothing has been set, which is the state every installation ships in.
    assert.equal(settings.get<string>('remote.status'), 'DISABLED');
    assert.equal(settings.get<string | null>('remote.hostname'), null);
    assert.equal(settings.get<string | null>('remote.expiresAt'), null);
  });

  test('an expired subscription does not touch what the restaurant may do', () => {
    const { settings, gate } = installation.services;
    const before = gate.current.capabilities;

    settings.set('remote.status', 'EXPIRED');
    settings.set('remote.expiresAt', '2020-01-01T00:00:00.000Z');

    /*
     * The point of the whole arrangement: remote access is a separate thing
     * that is sold separately, and its absence is not a reason for a till to
     * stop working. The licence gate decides what the restaurant may do, and it
     * has never heard of remote.
     */
    assert.deepEqual(gate.current.capabilities, before,
      'an expired remote subscription must not change a single local capability');

    settings.set('remote.status', 'DISABLED');
    settings.set('remote.expiresAt', null);
  });
});
