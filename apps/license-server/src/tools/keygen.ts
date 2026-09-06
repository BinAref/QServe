/**
 * Vendor signing key generator.
 *
 *   npm run keygen -- --out secrets/signing-key.json
 *
 * Writes two artefacts with very different handling rules:
 *
 *   secrets/signing-key.json      PRIVATE. Stays on the license server only.
 *   apps/server/config/trusted-keys.json
 *                                 PUBLIC. Ships inside the application so an
 *                                 installation can verify certificates offline.
 *
 * The private half is never copied into the distributed application, never
 * written to the database, and never committed (see .gitignore).
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateSigningKeyPair } from '@qserve/crypto';

interface TrustedKeysFile {
  keys: Record<string, string>;
}

function parseArgs(argv: readonly string[]): { out: string; trust: string; force: boolean } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) args.set(token.slice(2, eq), token.slice(eq + 1));
    else args.set(token.slice(2), argv[i + 1] ?? 'true');
  }
  return {
    out: resolve(args.get('out') ?? 'secrets/signing-key.json'),
    trust: resolve(args.get('trust') ?? 'apps/server/config/trusted-keys.json'),
    force: args.get('force') === 'true',
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const { out, trust, force } = parseArgs(argv);

  if (existsSync(out) && !force) {
    console.error(
      `Refusing to overwrite ${out}.\n` +
      'Overwriting a signing key invalidates every certificate it issued.\n' +
      'Pass --force only if you understand that, and keep the old key in the ' +
      'trust store so existing installations keep working.',
    );
    process.exitCode = 1;
    return;
  }

  const pair = generateSigningKeyPair();

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        keyId: pair.keyId,
        publicKey: pair.publicKey,
        privateKey: pair.privateKey,
        createdAt: new Date().toISOString(),
        warning: 'PRIVATE KEY. Never ship this file with the application.',
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  // Merge rather than replace: rotation must leave old keys verifiable, or
  // every restaurant already in the field would fail its next boot check.
  mkdirSync(dirname(trust), { recursive: true });
  let trusted: TrustedKeysFile = { keys: {} };
  if (existsSync(trust)) {
    try {
      trusted = JSON.parse(readFileSync(trust, 'utf8')) as TrustedKeysFile;
      if (typeof trusted.keys !== 'object' || trusted.keys === null) trusted = { keys: {} };
    } catch {
      trusted = { keys: {} };
    }
  }
  trusted.keys[pair.keyId] = pair.publicKey;
  writeFileSync(trust, `${JSON.stringify(trusted, null, 2)}\n`);

  console.log(`Signing key ${pair.keyId} generated.`);
  console.log(`  private key -> ${out}   (keep secret, mode 0600)`);
  console.log(`  trust store -> ${trust}  (ships with the app)`);
  console.log('\nStart the license server with:');
  console.log(`  QSERVE_LS_SIGNING_KEY_FILE=${out} npm run start:license-server`);
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main();
}
