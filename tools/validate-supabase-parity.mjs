#!/usr/bin/env node
/**
 * Does the Edge Function sign what the application can verify?
 *
 *   node tools/validate-supabase-parity.mjs
 *
 * The licence server moved to Supabase, which means the code that *signs* a
 * certificate is now a different implementation, in a different runtime, from
 * the code that *verifies* it — Deno's WebCrypto against Node's, in two files
 * that will be edited by different hands on different days. They agree today.
 * Nothing but a test keeps them agreeing.
 *
 * The failure this prevents is nasty and remote: a restaurant that has paid,
 * activating successfully, receiving a certificate its own computer then
 * refuses. The vendor would see a successful activation in the database and the
 * restaurant would see "this licence is not valid", and nothing in either log
 * would say why.
 *
 * So the actual Edge Function source is imported here — not a copy of it, not a
 * description of it — and made to sign a certificate, which is then handed to
 * the application's real verifier with a real trust store.
 */

import { generateSigningKeyPair, verifyCertificate, canonicalJson } from '../packages/crypto/dist/index.js';
import { CertificateVerdict } from '../packages/shared/dist/index.js';
import { issueCertificate, canonicalJson as denoCanonical, computeKeyId } from '../supabase/functions/api/crypto.ts';
import { normaliseLicenseKey as denoNormalise, generateLicenseKey } from '../supabase/functions/api/license-key.ts';
import { normaliseLicenseKey } from '../packages/shared/dist/license-key.js';

let failures = 0;
const check = (ok, what, extra = '') => {
  if (ok) {
    console.log(`  ✓ ${what}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${what}${extra ? ` — ${extra}` : ''}`);
  }
};

/* ------------------------------------------------------- canonical JSON */

console.log('canonical JSON');
const shapes = [
  { b: 1, a: 2 },
  { nested: { z: [1, 2, { y: 'x' }], a: null } },
  { unicode: 'مطعم — Türkçe', quote: '"', slash: '\\' },
  { dropped: undefined, kept: 0, negativeZero: -0 },
  [1, 'two', null, { three: 3 }],
  { big: 1234567890123, small: 0.5 },
];
for (const shape of shapes) {
  const node = canonicalJson(shape);
  const deno = denoCanonical(shape);
  check(node === deno, `same bytes for ${JSON.stringify(shape).slice(0, 44)}`,
    `node=${node} deno=${deno}`);
}

/* ------------------------------------------------------------- key ids */

console.log('key identity');
const signing = generateSigningKeyPair();
check(await computeKeyId(signing.publicKey) === signing.keyId,
  'the Edge Function derives the same keyId the vendor tool wrote');

/* ------------------------------------------------- a signed certificate */

console.log('a certificate signed in the Edge Function');
const payload = {
  v: 1,
  licenseId: 'LIC-2026-000001',
  licenseType: 'PERPETUAL',
  restaurantId: 'REST-000001',
  restaurantName: 'مطعم الاختبار',
  deviceFingerprint: 'a'.repeat(64),
  activationId: 'ACT-0123456789abcdef',
  issuedAt: new Date().toISOString(),
  transferCount: 0,
  appVersion: '1.0.14',
  notAfter: null,
  features: ['tables.provision', 'server.lan'],
};

const certificate = await issueCertificate(payload, signing.privateKey, signing.publicKey);
const trust = { keys: { [signing.keyId]: signing.publicKey } };

const verdict = verifyCertificate(certificate, trust, {
  deviceFingerprint: payload.deviceFingerprint,
  restaurantId: payload.restaurantId,
});
check(verdict.verdict === CertificateVerdict.VALID,
  'the application accepts it', `verdict=${verdict.verdict}`);
check(certificate.keyId === signing.keyId, 'it names the key that signed it');
check(certificate.alg === 'Ed25519', 'it declares Ed25519');

// And the negative: a tampered payload must not pass, or the check above is
// proving nothing at all.
const tampered = { ...certificate, payload: certificate.payload.replace('REST-000001', 'REST-000002') };
check(verifyCertificate(tampered, trust, {
  deviceFingerprint: payload.deviceFingerprint,
}).verdict !== CertificateVerdict.VALID, 'a tampered certificate is refused');

// A certificate signed for one machine must not validate on another.
check(verifyCertificate(certificate, trust, {
  deviceFingerprint: 'b'.repeat(64),
}).verdict !== CertificateVerdict.VALID, 'it is refused on a different device');

/* ---------------------------------------------------------- licence keys */

console.log('licence keys');
for (let i = 0; i < 200; i += 1) {
  const key = generateLicenseKey();
  if (normaliseLicenseKey(key) !== denoNormalise(key)) {
    check(false, 'both runtimes normalise the same key the same way', key);
    break;
  }
  if (i === 199) check(true, '200 generated keys normalise identically in both runtimes');
}
const messy = ' qsrv4k7qm9xtv2br5hnp83wc ';
check(normaliseLicenseKey(messy) === denoNormalise(messy),
  'and so does a key typed in lower case without dashes');
const broken = 'QSRV-4K7QM-9XTV2-BR5HN-P83WD';
check(normaliseLicenseKey(broken) === null && denoNormalise(broken) === null,
  'and both reject a key with a bad checksum');

console.log(failures === 0
  ? '\nthe Edge Function and the application agree'
  : `\n✗ ${failures} disagreement(s) between the Edge Function and the application`);
process.exit(failures === 0 ? 0 : 1);
