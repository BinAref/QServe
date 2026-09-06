/**
 * Cryptographic guarantees the commercial model rests on.
 *
 * If any of these break, either a restaurant can be locked out of its own data
 * or a licence can be forged. They are deliberately adversarial: each one tries
 * to defeat the mechanism rather than merely exercise it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVATION_CERTIFICATE_VERSION, CertificateVerdict,
  type ActivationCertificatePayload, type DeviceFingerprint, type RestaurantId,
} from '@qserve/shared';
import { canonicalJson } from './canonical-json.js';
import { computeKeyId, generateSigningKeyPair, signMessage, verifyMessage } from './signing.js';
import { issueCertificate, verifyCertificate } from './certificate.js';
import {
  BackupError, BackupErrorCode, assertNoVendorSecrets, createBackup,
  readBackup, readBackupHeader,
} from './backup.js';
import { fingerprintFromComponents, type FingerprintComponents } from './fingerprint.js';
import { constantTimeEquals, hashSecret, hashToken, newToken, verifySecret } from './hash.js';

/* ------------------------------------------------------ canonical JSON */

test('canonical JSON is stable regardless of key order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ a: [3, { d: 4, c: 5 }] }), '{"a":[3,{"c":5,"d":4}]}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson(-0), '0');
  assert.throws(() => canonicalJson(Number.NaN));
});

/* ------------------------------------------------------------- signing */

test('signatures verify, and any mutation breaks them', () => {
  const pair = generateSigningKeyPair();
  const signature = signMessage('hello', pair.privateKey);

  assert.ok(verifyMessage('hello', signature, pair.publicKey));
  assert.equal(verifyMessage('hell0', signature, pair.publicKey), false);
  assert.equal(verifyMessage('hello', signature, generateSigningKeyPair().publicKey), false);
  assert.equal(verifyMessage('hello', 'not-a-signature', pair.publicKey), false, 'must not throw');
});

test('key ids are derived from the public key, so rotation is identifiable', () => {
  const pair = generateSigningKeyPair();
  assert.equal(pair.keyId, computeKeyId(pair.publicKey));
  assert.notEqual(pair.keyId, generateSigningKeyPair().keyId);
});

/* -------------------------------------------------------- certificates */

const DEVICE = 'a'.repeat(64) as DeviceFingerprint;
const OTHER_DEVICE = 'b'.repeat(64) as DeviceFingerprint;

function samplePayload(over: Partial<ActivationCertificatePayload> = {}): ActivationCertificatePayload {
  return {
    v: ACTIVATION_CERTIFICATE_VERSION,
    licenseId: 'LIC-2026-000123' as never,
    licenseType: 'PERPETUAL',
    restaurantId: 'REST-000123' as RestaurantId,
    restaurantName: 'Al Bait',
    deviceFingerprint: DEVICE,
    activationId: 'ACT-1',
    issuedAt: new Date().toISOString(),
    transferCount: 0,
    appVersion: '1.0.0',
    notAfter: null,
    features: ['orders.runtime'],
    ...over,
  };
}

test('a valid certificate verifies offline', () => {
  const pair = generateSigningKeyPair();
  const trust = { keys: { [pair.keyId]: pair.publicKey } };
  const certificate = issueCertificate(samplePayload(), pair.privateKey, pair.publicKey);

  const check = verifyCertificate(certificate, trust, {
    deviceFingerprint: DEVICE, restaurantId: 'REST-000123' as RestaurantId,
  });
  assert.equal(check.verdict, CertificateVerdict.VALID);
  assert.equal(check.payload?.notAfter, null, 'perpetual licences never expire');
});

test('a certificate is bound to its device and its restaurant', () => {
  const pair = generateSigningKeyPair();
  const trust = { keys: { [pair.keyId]: pair.publicKey } };
  const certificate = issueCertificate(samplePayload(), pair.privateKey, pair.publicKey);

  assert.equal(
    verifyCertificate(certificate, trust, { deviceFingerprint: OTHER_DEVICE }).verdict,
    CertificateVerdict.DEVICE_MISMATCH,
    'copying the data folder to another PC must not activate it',
  );
  assert.equal(
    verifyCertificate(certificate, trust, {
      deviceFingerprint: DEVICE, restaurantId: 'REST-999999' as RestaurantId,
    }).verdict,
    CertificateVerdict.RESTAURANT_MISMATCH,
  );
});

test('a forged or tampered certificate is refused', () => {
  const pair = generateSigningKeyPair();
  const trust = { keys: { [pair.keyId]: pair.publicKey } };
  const certificate = issueCertificate(samplePayload(), pair.privateKey, pair.publicKey);

  // Editing the payload to grant more features breaks the signature.
  const tampered = {
    ...certificate,
    payload: certificate.payload.replace('"transferCount":0', '"transferCount":9'),
  };
  assert.equal(
    verifyCertificate(tampered, trust, { deviceFingerprint: DEVICE }).verdict,
    CertificateVerdict.BAD_SIGNATURE,
  );

  // A certificate signed by someone else's key, presented under a trusted id.
  const attacker = generateSigningKeyPair();
  const forged = issueCertificate(samplePayload(), attacker.privateKey, attacker.publicKey);
  assert.equal(
    verifyCertificate({ ...forged, keyId: pair.keyId }, trust, { deviceFingerprint: DEVICE }).verdict,
    CertificateVerdict.BAD_SIGNATURE,
  );

  // An unknown signer is refused before the signature is even considered.
  assert.equal(
    verifyCertificate(forged, trust, { deviceFingerprint: DEVICE }).verdict,
    CertificateVerdict.UNKNOWN_KEY_ID,
  );
});

test('missing, malformed and future-version certificates each report distinctly', () => {
  const pair = generateSigningKeyPair();
  const trust = { keys: { [pair.keyId]: pair.publicKey } };

  assert.equal(verifyCertificate(null, trust, { deviceFingerprint: DEVICE }).verdict,
    CertificateVerdict.MISSING);
  assert.equal(
    verifyCertificate({ alg: 'Ed25519', keyId: 'x', payload: 1 as never, signature: 'y' },
      trust, { deviceFingerprint: DEVICE }).verdict,
    CertificateVerdict.MALFORMED);

  const future = issueCertificate(samplePayload({ v: 99 }), pair.privateKey, pair.publicKey);
  assert.equal(verifyCertificate(future, trust, { deviceFingerprint: DEVICE }).verdict,
    CertificateVerdict.UNSUPPORTED_VERSION);
});

test('a time-limited certificate expires; a perpetual one does not', () => {
  const pair = generateSigningKeyPair();
  const trust = { keys: { [pair.keyId]: pair.publicKey } };

  const expiring = issueCertificate(
    samplePayload({ notAfter: '2020-01-01T00:00:00.000Z' }), pair.privateKey, pair.publicKey);
  assert.equal(verifyCertificate(expiring, trust, { deviceFingerprint: DEVICE }).verdict,
    CertificateVerdict.EXPIRED);

  const perpetual = issueCertificate(samplePayload(), pair.privateKey, pair.publicKey);
  const farFuture = new Date('2099-01-01T00:00:00.000Z');
  assert.equal(
    verifyCertificate(perpetual, trust, { deviceFingerprint: DEVICE, now: farFuture }).verdict,
    CertificateVerdict.VALID,
    'a perpetual licence must still work in 2099',
  );
});

/* -------------------------------------------------------------- backup */

const backupInput = {
  restaurantId: 'REST-000123',
  appVersion: '1.0.0',
  schemaVersion: 1,
  passphrase: 'correct horse battery',
};

test('a backup round-trips exactly', () => {
  const payload = { categories: [{ id: 'c1', name: { ar: 'مشويات' } }], count: 2 };
  const file = createBackup({ ...backupInput, payload, note: 'before the move' });

  const read = readBackup<typeof payload>(file, backupInput.passphrase);
  assert.deepEqual(read.payload, payload);
  assert.equal(read.header.restaurantId, 'REST-000123');
  assert.equal(read.header.note, 'before the move');
});

test('the header is readable without the passphrase, the payload is not', () => {
  // This is what lets an operator check which restaurant a file holds before
  // committing to a restore.
  const file = createBackup({ ...backupInput, payload: { secret: 'menu' } });

  const header = readBackupHeader(file);
  assert.equal(header.restaurantId, 'REST-000123');
  assert.equal(header.cipher, 'aes-256-gcm');
  assert.equal(file.includes(Buffer.from('menu')), false, 'the payload must be ciphertext');
});

test('a wrong passphrase and a tampered file both fail authentication', () => {
  const file = createBackup({ ...backupInput, payload: { a: 1 } });

  assert.throws(() => readBackup(file, 'wrong passphrase'),
    (e: unknown) => e instanceof BackupError && e.code === BackupErrorCode.AUTH_FAILED);

  const flippedCiphertext = Buffer.from(file);
  flippedCiphertext[flippedCiphertext.length - 3]! ^= 0xff;
  assert.throws(() => readBackup(flippedCiphertext, backupInput.passphrase),
    (e: unknown) => e instanceof BackupError && e.code === BackupErrorCode.AUTH_FAILED);
});

test('editing the authenticated header is detected', () => {
  // The header is AES-GCM associated data, so rewriting the restaurant id in a
  // hex editor invalidates the whole file rather than silently succeeding.
  const file = createBackup({ ...backupInput, payload: { a: 1 } });
  const edited = Buffer.from(
    file.toString('binary').replace('REST-000123', 'REST-999999'), 'binary');

  assert.throws(() => readBackup(edited, backupInput.passphrase), BackupError);
});

test('a non-backup file and a truncated one are reported distinctly', () => {
  assert.throws(() => readBackupHeader(Buffer.from('hello world, not a backup')),
    (e: unknown) => e instanceof BackupError && e.code === BackupErrorCode.BAD_MAGIC);

  const file = createBackup({ ...backupInput, payload: { a: 1 } });
  assert.throws(() => readBackupHeader(file.subarray(0, 10)),
    (e: unknown) => e instanceof BackupError && e.code === BackupErrorCode.TRUNCATED);
});

test('a backup can never carry vendor key material', () => {
  // The spec forbids it, and a restaurant will happily email a backup to
  // support, so this is enforced rather than documented.
  assert.throws(
    () => createBackup({ ...backupInput, payload: { vendor: { privateKey: 'oops' } } }),
    (e: unknown) => e instanceof BackupError && e.code === BackupErrorCode.VENDOR_SECRET_PRESENT,
  );
  assert.throws(() => assertNoVendorSecrets({ deep: [{ signingKey: 'x' }] }), BackupError);
  assert.doesNotThrow(() => assertNoVendorSecrets({ publicKey: 'fine', keyId: 'fine' }));
});

test('a short passphrase is refused at creation', () => {
  assert.throws(() => createBackup({ ...backupInput, passphrase: 'short', payload: {} }), BackupError);
});

/* --------------------------------------------------------- fingerprint */

const components: FingerprintComponents = {
  installId: 'install-1', machineId: 'machine-1', hostname: 'kitchen-pc',
  platform: 'linux', arch: 'x64', cpuModel: 'Intel i5', cpuCount: 8,
  memoryGb: 16, macAddresses: ['aa:bb:cc:dd:ee:ff'],
};

test('the fingerprint is reproducible and changes with any component', () => {
  const base = fingerprintFromComponents(components);
  assert.match(base.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprintFromComponents(components).fingerprint, base.fingerprint,
    'must be stable across restarts and app upgrades');

  for (const change of [
    { installId: 'install-2' },
    { machineId: 'machine-2' },
    { cpuModel: 'AMD Ryzen' },
    { macAddresses: ['11:22:33:44:55:66'] },
  ]) {
    assert.notEqual(
      fingerprintFromComponents({ ...components, ...change }).fingerprint,
      base.fingerprint,
      JSON.stringify(change),
    );
  }
});

test('the fingerprint does not rest on MAC addresses alone', () => {
  // Spec §3 is explicit about this: a spoofed MAC must not be enough.
  const noMac = fingerprintFromComponents({ ...components, macAddresses: [] });
  const spoofed = fingerprintFromComponents({
    ...components, installId: 'other-install', macAddresses: ['aa:bb:cc:dd:ee:ff'],
  });
  assert.notEqual(noMac.fingerprint, spoofed.fingerprint);
  assert.notEqual(fingerprintFromComponents(components).fingerprint, spoofed.fingerprint);
});

test('component digests aid support without revealing raw values', () => {
  const result = fingerprintFromComponents(components);
  assert.equal(result.label, 'kitchen-pc (linux/x64)');
  for (const [key, digest] of Object.entries(result.componentDigests)) {
    assert.match(digest, /^[0-9a-f]{12}$/, key);
    assert.equal(digest.includes('kitchen-pc'), false);
  }
});

/* -------------------------------------------------------------- hashing */

test('secrets verify against their hash and nothing else', () => {
  const stored = hashSecret('4271');
  assert.ok(verifySecret('4271', stored));
  assert.equal(verifySecret('4272', stored), false);
  assert.notEqual(hashSecret('4271'), stored, 'each hash carries its own salt');
  assert.equal(verifySecret('4271', 'garbage'), false, 'a corrupt hash must not throw');
});

test('tokens are unique, and comparison is constant time', () => {
  const token = newToken();
  assert.notEqual(token, newToken());
  assert.equal(hashToken(token), hashToken(token));
  assert.ok(constantTimeEquals('abc', 'abc'));
  assert.equal(constantTimeEquals('abc', 'abd'), false);
  assert.equal(constantTimeEquals('abc', 'abcd'), false, 'differing lengths must not throw');
});
