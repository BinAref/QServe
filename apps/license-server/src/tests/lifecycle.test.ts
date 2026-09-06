/**
 * Licence lifecycle: the commercial rules of the product (spec §5, §6, §27).
 *
 * These run against the real store and service, with no HTTP layer, so each
 * rule is asserted directly rather than through a status code.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, runMigrations, type Db } from '@qserve/db';
import { generateSigningKeyPair, hashToken, verifyCertificate } from '@qserve/crypto';
import {
  CertificateVerdict, LicenseErrorCode, LicenseStatus, generateLicenseKey,
  type ActivationRequest, type DeviceFingerprint,
} from '@qserve/shared';

import { migrations } from '../schema.js';
import { LicenseStore } from '../store.js';
import { LicenseService } from '../service.js';

const DEVICE_A = 'a'.repeat(64) as DeviceFingerprint;
const DEVICE_B = 'b'.repeat(64) as DeviceFingerprint;

function setup() {
  const db: Db = openDatabase({ file: ':memory:' });
  runMigrations(db, migrations);

  const signing = generateSigningKeyPair();
  const store = new LicenseStore(db);
  const service = new LicenseService(
    store,
    { privateKey: signing.privateKey, publicKey: signing.publicKey, keyId: signing.keyId },
    2026,
    generateLicenseKey,
  );
  service.registerOwnKey();

  return { db, store, service, trust: { keys: { [signing.keyId]: signing.publicKey } } };
}

const activation = (licenseKey: string, device: DeviceFingerprint): ActivationRequest => ({
  licenseKey,
  deviceFingerprint: device,
  deviceLabel: 'restaurant-pc',
  appVersion: '1.0.0',
  nonce: 'nonce-12345678',
});

const codeOf = (error: unknown): string => (error as { code: string }).code;

describe('issuing', () => {
  test('a licence is issued with generated ids and a key shown once', () => {
    const { service, store } = setup();
    const issued = service.issueLicense({ restaurantName: 'Al Bait', actor: 'dev' });

    assert.match(issued.restaurant.restaurant_id, /^REST-\d{6}$/);
    assert.match(issued.license.license_id, /^LIC-2026-\d{6}$/);
    assert.equal(issued.license.status, LicenseStatus.PENDING);
    assert.equal(issued.license.license_type, 'PERPETUAL');

    // Only the hash is retained, so the vendor's database cannot leak keys.
    assert.equal(issued.license.key_hash, hashToken(issued.licenseKey));
    assert.equal(issued.license.key_hint, issued.licenseKey.slice(-5));
    assert.equal(store.getLicenseByKeyHash(hashToken(issued.licenseKey))?.license_id,
      issued.license.license_id);
  });

  test('ids increment, and a second licence can join an existing restaurant', () => {
    const { service } = setup();
    const first = service.issueLicense({ restaurantName: 'One', actor: 'dev' });
    const second = service.issueLicense({ restaurantName: 'Two', actor: 'dev' });
    assert.equal(first.restaurant.restaurant_id, 'REST-000001');
    assert.equal(second.restaurant.restaurant_id, 'REST-000002');

    const extra = service.issueLicense({ restaurantId: 'REST-000001', actor: 'dev' });
    assert.equal(extra.restaurant.restaurant_id, 'REST-000001');
    assert.equal(extra.license.license_id, 'LIC-2026-000003');
  });
});

describe('activation', () => {
  let context: ReturnType<typeof setup>;
  let key: string;
  let licenseId: string;
  let restaurantId: string;

  beforeEach(() => {
    context = setup();
    const issued = context.service.issueLicense({ restaurantName: 'Al Bait', actor: 'dev' });
    key = issued.licenseKey;
    licenseId = issued.license.license_id;
    restaurantId = issued.restaurant.restaurant_id;
  });

  test('the first activation is free and returns a verifiable certificate', () => {
    const response = context.service.activate(activation(key, DEVICE_A), '10.0.0.1');

    assert.equal(response.nonce, 'nonce-12345678', 'the reply must answer this request');
    assert.equal(response.restaurantId, restaurantId);

    const check = verifyCertificate(response.certificate, context.trust, {
      deviceFingerprint: DEVICE_A, restaurantId: restaurantId as never,
    });
    assert.equal(check.verdict, CertificateVerdict.VALID);
    assert.equal(check.payload?.notAfter, null, 'perpetual');
    assert.equal(check.payload?.transferCount, 0);
    assert.equal(context.store.getLicense(licenseId)?.status, LicenseStatus.ACTIVE);
  });

  test('a malformed or unknown key is refused before anything else happens', () => {
    assert.throws(() => context.service.activate(activation('QSRV-AAAAA-AAAAA-AAAAA-AAAAA', DEVICE_A), null),
      (error) => codeOf(error) === LicenseErrorCode.UNKNOWN_KEY);
    assert.throws(() => context.service.activate(activation('not-a-key', DEVICE_A), null),
      (error) => codeOf(error) === LicenseErrorCode.INVALID_KEY_FORMAT);
  });

  test('one licence cannot be live on two machines', () => {
    context.service.activate(activation(key, DEVICE_A), null);
    assert.throws(
      () => context.service.activate(activation(key, DEVICE_B), null),
      (error) => codeOf(error) === LicenseErrorCode.ALREADY_ACTIVE_ELSEWHERE,
    );
  });

  test('the same machine re-activating is free and idempotent', () => {
    // Reinstalling the app, or restoring on the same PC, must not cost money.
    context.service.activate(activation(key, DEVICE_A), null);
    const again = context.service.activate(activation(key, DEVICE_A), null);

    const check = verifyCertificate(again.certificate, context.trust, { deviceFingerprint: DEVICE_A });
    assert.equal(check.verdict, CertificateVerdict.VALID);
    assert.equal(context.store.getLicense(licenseId)?.transfer_count, 0, 'not counted as a transfer');
    assert.equal(context.store.transferHistory(licenseId).length, 0);
  });

  test('an installation cannot attach a licence belonging to another restaurant', () => {
    assert.throws(
      () => context.service.activate(
        { ...activation(key, DEVICE_A), restaurantId: 'REST-999999' as never }, null),
      (error) => codeOf(error) === LicenseErrorCode.RESTAURANT_MISMATCH,
    );
  });

  test('activation is impossible without a signing key configured', () => {
    const { db, store } = setup();
    const unsigned = new LicenseService(store, null, 2026, generateLicenseKey);
    const issued = unsigned.issueLicense({ restaurantName: 'X', actor: 'dev' });

    assert.throws(() => unsigned.activate(activation(issued.licenseKey, DEVICE_A), null),
      (error) => (error as { status: number }).status === 503);
    db.close();
  });
});

describe('transfer', () => {
  let context: ReturnType<typeof setup>;
  let key: string;
  let licenseId: string;

  beforeEach(() => {
    context = setup();
    const issued = context.service.issueLicense({ restaurantName: 'Al Bait', actor: 'dev' });
    key = issued.licenseKey;
    licenseId = issued.license.license_id;
    context.service.activate(activation(key, DEVICE_A), null);
  });

  test('moving to a new machine needs a paid transfer', () => {
    context.service.deactivate(
      { licenseKey: key, deviceFingerprint: DEVICE_A, reason: 'new pc', nonce: 'n-12345678' }, null);
    assert.equal(context.store.getLicense(licenseId)?.status, LicenseStatus.DEACTIVATED);

    assert.throws(
      () => context.service.activate(activation(key, DEVICE_B), null),
      (error) => codeOf(error) === LicenseErrorCode.TRANSFER_NOT_PAID,
    );

    context.service.grantTransferCredit(licenseId, 'INV-77', 'dev', null);
    const moved = context.service.activate(activation(key, DEVICE_B), null);

    const check = verifyCertificate(moved.certificate, context.trust, { deviceFingerprint: DEVICE_B });
    assert.equal(check.verdict, CertificateVerdict.VALID);
    assert.equal(check.payload?.transferCount, 1);

    const license = context.store.getLicense(licenseId)!;
    assert.equal(license.transfer_credits, 0, 'the credit is consumed, not reusable');
    assert.equal(license.transfer_count, 1);

    // The restaurant keeps its identity across the move (spec §4).
    assert.equal(check.payload?.restaurantId, 'REST-000001');
  });

  test('only the bound device may deactivate itself', () => {
    assert.throws(
      () => context.service.deactivate(
        { licenseKey: key, deviceFingerprint: DEVICE_B, reason: 'x', nonce: 'n-12345678' }, null),
      (error) => codeOf(error) === LicenseErrorCode.DEVICE_MISMATCH,
    );
  });

  test('the vendor can release a dead or stolen machine', () => {
    // The case the spec calls out: the old computer cannot deactivate itself.
    context.service.adminReleaseDevice(licenseId, 'hardware failure', 'dev', null);
    assert.equal(context.store.liveActivation(licenseId), undefined);

    context.service.grantTransferCredit(licenseId, 'INV-88', 'dev', null);
    assert.doesNotThrow(() => context.service.activate(activation(key, DEVICE_B), null));
  });

  test('activation and transfer history is kept, never overwritten', () => {
    context.service.adminReleaseDevice(licenseId, 'sold the pc', 'dev', null);
    context.service.grantTransferCredit(licenseId, 'INV-99', 'dev', null);
    context.service.activate(activation(key, DEVICE_B), null);

    const history = context.store.activationHistory(licenseId);
    assert.equal(history.length, 2);
    assert.equal(history.filter((row) => row.released_at === null).length, 1,
      'exactly one live binding at any time');

    const transfers = context.store.transferHistory(licenseId);
    assert.ok(transfers.some((row) => row.fee_reference === 'INV-99'));
    assert.ok(transfers.some((row) => row.to_fingerprint === DEVICE_B));
  });
});

describe('revocation', () => {
  test('a revoked licence cannot activate, transfer or be re-credited', () => {
    const context = setup();
    const issued = context.service.issueLicense({ restaurantName: 'Al Bait', actor: 'dev' });
    const { licenseKey } = issued;
    const licenseId = issued.license.license_id;

    context.service.activate(activation(licenseKey, DEVICE_A), null);
    context.service.revoke(licenseId, 'chargeback', 'dev', null);

    const license = context.store.getLicense(licenseId)!;
    assert.equal(license.status, LicenseStatus.REVOKED);
    assert.equal(license.transfer_credits, 0);
    assert.equal(context.store.liveActivation(licenseId), undefined, 'the device is released');

    assert.throws(() => context.service.activate(activation(licenseKey, DEVICE_A), null),
      (error) => codeOf(error) === LicenseErrorCode.REVOKED);
    assert.throws(() => context.service.grantTransferCredit(licenseId, null, 'dev', null),
      (error) => codeOf(error) === LicenseErrorCode.REVOKED);
  });

  test('reinstating requires the restaurant to activate again', () => {
    const context = setup();
    const issued = context.service.issueLicense({ restaurantName: 'Al Bait', actor: 'dev' });
    const licenseId = issued.license.license_id;

    context.service.activate(activation(issued.licenseKey, DEVICE_A), null);
    context.service.revoke(licenseId, 'dispute', 'dev', null);
    context.service.reinstate(licenseId, 'settled', 'dev', null);

    assert.equal(context.store.getLicense(licenseId)?.status, LicenseStatus.DEACTIVATED);
    // Re-establishing the binding on the machine it was already on is free.
    assert.doesNotThrow(() => context.service.activate(activation(issued.licenseKey, DEVICE_A), null));
  });

  test('every action is written to the audit log', () => {
    const context = setup();
    const issued = context.service.issueLicense({ restaurantName: 'Al Bait', actor: 'dev' });
    context.service.activate(activation(issued.licenseKey, DEVICE_A), '10.0.0.9');
    context.service.revoke(issued.license.license_id, 'test', 'dev', null);

    const actions = (context.store.recentAudit(20) as { action: string }[]).map((row) => row.action);
    assert.deepEqual(actions.slice(0, 3), ['license.revoked', 'license.activated', 'license.issued']);
  });
});

describe('status', () => {
  test('a status probe reports the binding without exposing the key', () => {
    const context = setup();
    const issued = context.service.issueLicense({ restaurantName: 'Al Bait', actor: 'dev' });
    context.service.activate(activation(issued.licenseKey, DEVICE_A), null);

    const status = context.service.statusByKey(issued.licenseKey);
    assert.equal(status.status, LicenseStatus.ACTIVE);
    assert.equal(status.boundDeviceFingerprint, DEVICE_A);
    assert.equal(status.restaurantName, 'Al Bait');
    assert.equal(status.transferCount, 0);
    assert.equal(Object.hasOwn(status, 'keyHash'), false);
  });

  test('the public view never carries the key hash', () => {
    const context = setup();
    const issued = context.service.issueLicense({ restaurantName: 'Al Bait', actor: 'dev' });
    const view = LicenseStore.publicView(context.store.getLicense(issued.license.license_id)!);
    assert.equal(Object.hasOwn(view, 'key_hash'), false);
    assert.equal((view as { key_hint: string }).key_hint, issued.licenseKey.slice(-5));
  });
});
