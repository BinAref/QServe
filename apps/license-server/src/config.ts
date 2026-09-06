/**
 * License server configuration.
 *
 * Everything sensitive comes from the environment, never from the repository.
 * The signing private key in particular is read from a file or an env var and
 * is never written to the database — see docs/SECURITY.md.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LicenseServerConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly databaseFile: string;
  /** base64url raw Ed25519 seed. Required to issue certificates. */
  readonly signingPrivateKey: string | null;
  readonly signingPublicKey: string | null;
  /** Year stamped into new license ids, e.g. LIC-2026-000123. */
  readonly licenseYear: number;
  /** Bootstrap developer account, created once if no admin exists. */
  readonly bootstrapAdminUsername: string | null;
  readonly bootstrapAdminPassword: string | null;
  /** Trust `x-forwarded-for` — only enable behind a reverse proxy you control. */
  readonly trustProxy: boolean;
}

function readKeyMaterial(
  env: NodeJS.ProcessEnv,
): { privateKey: string | null; publicKey: string | null } {
  const inline = env.QSERVE_LS_SIGNING_PRIVATE_KEY?.trim();
  const inlinePublic = env.QSERVE_LS_SIGNING_PUBLIC_KEY?.trim();
  if (inline) return { privateKey: inline, publicKey: inlinePublic ?? null };

  const file = env.QSERVE_LS_SIGNING_KEY_FILE?.trim();
  if (!file) return { privateKey: null, publicKey: null };

  try {
    const parsed = JSON.parse(readFileSync(resolve(file), 'utf8')) as {
      privateKey?: string;
      publicKey?: string;
    };
    return { privateKey: parsed.privateKey ?? null, publicKey: parsed.publicKey ?? null };
  } catch (error) {
    throw new Error(
      `could not read signing key file "${file}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LicenseServerConfig {
  const dataDir = resolve(env.QSERVE_LS_DATA_DIR ?? './data/license-server');
  const keys = readKeyMaterial(env);

  return {
    host: env.QSERVE_LS_HOST ?? '0.0.0.0',
    port: Number(env.QSERVE_LS_PORT ?? 8090),
    dataDir,
    databaseFile: env.QSERVE_LS_DATABASE ?? resolve(dataDir, 'licenses.sqlite'),
    signingPrivateKey: keys.privateKey,
    signingPublicKey: keys.publicKey,
    licenseYear: Number(env.QSERVE_LS_LICENSE_YEAR ?? new Date().getUTCFullYear()),
    bootstrapAdminUsername: env.QSERVE_LS_ADMIN_USERNAME ?? null,
    bootstrapAdminPassword: env.QSERVE_LS_ADMIN_PASSWORD ?? null,
    trustProxy: env.QSERVE_LS_TRUST_PROXY === 'true',
  };
}
