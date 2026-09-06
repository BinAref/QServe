/**
 * The licence gate — the commercial control the whole product rests on
 * (spec §2, §38, §52).
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { Capability, CertificateVerdict, RestaurantMode } from '@qserve/shared';
import { createInstallation, seedRestaurant, type Installation } from './harness.js';

describe('licence gate', () => {
  let installation: Installation;

  before(() => {
    installation = createInstallation();
    seedRestaurant(installation);
  });
  after(() => installation.dispose());

  test('a fresh installation is in SETUP and says why', () => {
    const { gate } = installation.services;
    assert.equal(gate.mode, RestaurantMode.SETUP);
    assert.equal(gate.current.verdict, CertificateVerdict.MISSING);
    assert.equal(gate.explain(), 'license.state.not_activated');
  });

  test('SETUP allows menu authoring and refuses live service', () => {
    const { gate } = installation.services;

    assert.doesNotThrow(() => gate.assert(Capability.MENU_AUTHORING));
    assert.doesNotThrow(() => gate.assert(Capability.BRANDING));
    assert.doesNotThrow(() => gate.assert(Capability.BACKUP));

    for (const gated of [
      Capability.LAN_SERVER, Capability.TABLES_PROVISION, Capability.TERMINALS_PROVISION,
      Capability.ORDERS_RUNTIME, Capability.CASHIER_RUNTIME, Capability.PRINTING_RUNTIME,
    ]) {
      assert.throws(() => gate.assert(gated), (error: unknown) => {
        const app = error as { code: string; status: number; details: Record<string, unknown> };
        // 402 Payment Required, carrying the capability, is what turns into the
        // "activate your licence" panel rather than a generic error.
        return app.code === 'LICENSE_REQUIRED' && app.status === 402
          && app.details['capability'] === gated;
      }, gated);
    }
  });

  test('provisioning a table in SETUP is refused by the service, not just the UI', () => {
    assert.throws(
      () => installation.services.terminals.createTable({
        label: 'Table 01', actor: installation.systemActor, clientIp: null,
      }),
      (error: unknown) => (error as { code: string }).code === 'LICENSE_REQUIRED',
    );
    assert.equal(installation.services.tables.list().length, 0);
  });

  test('activation unlocks everything and keeps the menu built in SETUP', () => {
    const before = installation.services.menu.listProducts().length;
    assert.ok(before > 0);

    installation.activate('REST-000001');

    const { gate, settings, menu } = installation.services;
    assert.equal(gate.mode, RestaurantMode.OPERATIONAL);
    assert.equal(gate.current.verdict, CertificateVerdict.VALID);

    // The vendor's Restaurant ID replaces the provisional one, and the data
    // stays attached to it — the whole point of SETUP over a demo.
    assert.equal(settings.profile()?.restaurantId, 'REST-000001');
    assert.equal(menu.listProducts().length, before, 'the menu must survive activation');

    for (const capability of Object.values(Capability)) {
      assert.doesNotThrow(() => gate.assert(capability), capability);
    }
  });

  test('a certificate is verified offline on every boot', () => {
    // No network is available in this test at all, which is the point: a vendor
    // outage cannot close a restaurant.
    const snapshot = installation.services.gate.evaluate('REST-000001' as never);
    assert.equal(snapshot.mode, RestaurantMode.OPERATIONAL);
  });

  test('the licence key is stored outside the database, so backups cannot leak it', () => {
    const { licenseRepository, paths } = installation.services;
    licenseRepository.rememberKey('QSRV-ABCDE-ABCDE-ABCDE-ABCDE');

    assert.ok(existsSync(paths.licenseKeyFile));
    assert.equal(licenseRepository.rememberedKey(), 'QSRV-ABCDE-ABCDE-ABCDE-ABCDE');

    // Only a hint reaches the database.
    assert.equal(licenseRepository.state().key_hint, 'ABCDE');
    const database = readFileSync(paths.databaseFile);
    assert.equal(database.includes(Buffer.from('QSRV-ABCDE-ABCDE-ABCDE-ABCDE')), false);
  });

  test('tampering with the stored certificate drops the installation back to SETUP', () => {
    const { gate, paths } = installation.services;
    const original = readFileSync(paths.certificateFile, 'utf8');

    const certificate = JSON.parse(original) as { payload: string };
    certificate.payload = certificate.payload.replace('"transferCount":0', '"transferCount":5');
    writeFileSync(paths.certificateFile, JSON.stringify(certificate));

    const snapshot = gate.evaluate('REST-000001' as never);
    assert.equal(snapshot.verdict, CertificateVerdict.BAD_SIGNATURE);
    assert.equal(snapshot.mode, RestaurantMode.SETUP);
    assert.throws(() => gate.assert(Capability.ORDERS_RUNTIME));

    writeFileSync(paths.certificateFile, original);
    assert.equal(gate.evaluate('REST-000001' as never).mode, RestaurantMode.OPERATIONAL);
  });

  test('deactivating clears the binding but never the restaurant data', () => {
    const { gate, menu } = installation.services;
    const products = menu.listProducts().length;

    const snapshot = gate.clearCertificate();
    assert.equal(snapshot.mode, RestaurantMode.SETUP);
    assert.equal(menu.listProducts().length, products,
      'moving to a new computer must not cost a restaurant its menu');

    installation.activate('REST-000001');
    assert.equal(gate.mode, RestaurantMode.OPERATIONAL);
  });
});

describe('device binding', () => {
  test("one restaurant's certificate does not activate another restaurant", () => {
    const installation = createInstallation();
    try {
      seedRestaurant(installation);
      installation.activate('REST-000001');

      // Simulates restoring a backup that names a different restaurant.
      installation.services.settings.adoptRestaurantId('REST-000999');
      const snapshot = installation.services.gate.evaluate('REST-000999' as never);

      assert.equal(snapshot.verdict, CertificateVerdict.RESTAURANT_MISMATCH);
      assert.equal(snapshot.mode, RestaurantMode.SETUP);
    } finally {
      installation.dispose();
    }
  });

  test('two installations get different fingerprints, so a copied folder cannot clone a licence', () => {
    const first = createInstallation();
    const second = createInstallation();
    try {
      assert.notEqual(
        first.services.fingerprint.fingerprint,
        second.services.fingerprint.fingerprint,
        'the persisted install id must differentiate installations on one machine',
      );
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
