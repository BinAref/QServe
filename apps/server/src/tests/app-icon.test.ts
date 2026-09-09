/**
 * The icon and the manifest every screen points at.
 *
 * Two things a restaurant gets for uploading its logo: the mark on the browser
 * tab of every station, and — when a waiter adds a station to a phone's home
 * screen — an icon named after the restaurant rather than after the software.
 *
 * The manifest is the part with a sharp edge in it. A front-end's folder name
 * is not the address it is served at: the diner's app lives in `web/customer`
 * and is served at `/menu`, because that is the word on the printed card. A
 * manifest that says `/customer/` produces a home-screen icon that opens a 404,
 * which is worse than no icon at all — it is an icon that looks like the
 * restaurant's own and is broken. That is exactly what shipped until this test
 * existed, so the paths are checked against the router rather than against a
 * second copy of the same assumption.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { IncomingMessage } from 'node:http';
import type { RequestContext } from '@qserve/http';
import { HttpResponse } from '@qserve/http';

import { createAssetFileRoutes } from '../http/routes/content.js';
import type { AppState } from '../core/security.js';
import { createInstallation, seedRestaurant, type Installation } from './harness.js';

let installation: Installation;

/** Ask the asset routes for something, the way the server would. */
async function get(path: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
  const router = createAssetFileRoutes(installation.services);
  const [route, rawQuery = ''] = path.split('?');
  const match = router.resolve('GET', route!);
  assert.ok(match, `no route for GET ${route}`);

  const ctx = {
    req: { headers } as unknown as IncomingMessage,
    params: match.params,
    query: new URLSearchParams(rawQuery),
    ip: '127.0.0.1',
    state: {} as AppState,
  } as unknown as RequestContext<AppState>;

  const result = await match.handler(ctx);
  assert.ok(result instanceof HttpResponse, 'the asset routes answer with raw responses');
  return result;
}

const manifest = async (app: string): Promise<Record<string, unknown>> =>
  JSON.parse((await get(`/app.webmanifest?app=${app}`)).body!.toString('utf8'));

describe('the app icon', () => {
  before(() => {
    installation = createInstallation();
    seedRestaurant(installation);
  });
  after(() => installation.dispose());

  test('a restaurant with no logo still gets an icon', async () => {
    const response = await get('/app-icon');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/svg+xml');
    assert.ok(response.body!.length > 0, 'the shipped mark stands in until one is uploaded');
  });

  test('an uploaded logo is served in its place, and changes the tag', async () => {
    const before = (await get('/app-icon')).headers['etag'];

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const asset = await installation.services.assets.store({
      bytes: png,
      contentType: 'image/png',
      kind: 'logo',
      actor: installation.systemActor,
      clientIp: null,
    });
    installation.services.settings.updateRestaurant({ logoAssetId: asset.id });

    const response = await get('/app-icon');
    assert.equal(response.headers['content-type'], 'image/png');
    assert.notEqual(response.headers['etag'], before,
      'an owner who changes the logo must not have to explain a cache to their staff');
  });

  test('an unchanged icon is answered without sending it again', async () => {
    const etag = (await get('/app-icon')).headers['etag']!;
    const response = await get('/app-icon', { 'if-none-match': etag });
    assert.equal(response.status, 304);
    assert.equal(response.headers['content-security-policy'], (await get('/app-icon')).headers['content-security-policy'],
      'a browser answering from cache keeps the headers it stored, so the 304 has to restate the policy');
  });

  test('uploaded images are served inert', async () => {
    for (const path of ['/app-icon']) {
      const policy = (await get(path)).headers['content-security-policy'];
      assert.ok(policy?.includes('sandbox'),
        `${path} must sandbox what a restaurant uploaded, whatever it turned out to be`);
      assert.ok(policy?.includes("default-src 'none'"), `${path} must allow it nothing`);
    }
  });
});

describe('the manifest each station points at', () => {
  before(() => {
    installation = createInstallation();
    seedRestaurant(installation);
  });
  after(() => installation.dispose());

  /**
   * The addresses in `app.ts`. Kept here as the expectation rather than
   * imported, because importing the map the code uses would let both move
   * together and still be wrong — which is how `/customer/` shipped.
   */
  const SERVED_AT: Readonly<Record<string, string>> = {
    console: '/console/',
    customer: '/menu/',
    waiter: '/waiter/',
    cashier: '/cashier/',
    kitchen: '/kitchen/',
    printer: '/printer/',
  };

  for (const [app, path] of Object.entries(SERVED_AT)) {
    test(`${app} opens at ${path}`, async () => {
      const parsed = await manifest(app);
      assert.equal(parsed['start_url'], path);
      assert.equal(parsed['scope'], path);
    });
  }

  test('it carries the restaurant’s name, not the product’s', async () => {
    const parsed = await manifest('waiter');
    assert.ok(String(parsed['short_name']).length > 0);
    assert.notEqual(parsed['short_name'], 'QServe',
      'a waiter adding four stations to a phone has to tell them apart');
  });

  test('an unknown station is not a way to choose a start_url', async () => {
    for (const junk of ['../../etc/passwd', 'https://example.com', '']) {
      const parsed = await manifest(encodeURIComponent(junk));
      assert.equal(parsed['start_url'], '/console/',
        'a query string picks from the map or gets the default, never writes the path');
    }
  });
});
