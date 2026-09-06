/**
 * On-disk layout for one restaurant installation.
 *
 * The split matters. `restaurant.sqlite` and `assets/` are the restaurant's own
 * data and belong in every backup. `install-id` and `license/` are *this
 * machine's* credentials: they are excluded from backups on purpose, so that
 * restoring a backup onto a new PC does not smuggle the old machine's licence
 * binding with it. Moving to new hardware is a licence transfer (spec §6), and
 * the file layout makes that the only possible outcome.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Paths {
  readonly dataDir: string;
  readonly databaseFile: string;
  readonly assetsDir: string;
  readonly backupsDir: string;
  readonly licenseDir: string;
  readonly certificateFile: string;
  readonly licenseKeyFile: string;
  readonly installIdFile: string;
  readonly spoolDir: string;
  readonly logDir: string;
}

export function resolvePaths(dataDir: string): Paths {
  const root = resolve(dataDir);
  return {
    dataDir: root,
    databaseFile: join(root, 'restaurant.sqlite'),
    assetsDir: join(root, 'assets'),
    backupsDir: join(root, 'backups'),
    licenseDir: join(root, 'license'),
    certificateFile: join(root, 'license', 'certificate.json'),
    licenseKeyFile: join(root, 'license', 'key'),
    installIdFile: join(root, 'install-id'),
    spoolDir: join(root, 'spool'),
    logDir: join(root, 'logs'),
  };
}

export function ensureDirectories(paths: Paths): void {
  for (const dir of [
    paths.dataDir, paths.assetsDir, paths.backupsDir,
    paths.licenseDir, paths.spoolDir, paths.logDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * A random value generated once per installation and never carried by a backup.
 * It is one of the inputs to the device fingerprint, which is what makes a
 * restored backup on new hardware fail activation instead of silently cloning a
 * licence onto a second machine.
 */
export function readOrCreateInstallId(paths: Paths): string {
  if (existsSync(paths.installIdFile)) {
    const existing = readFileSync(paths.installIdFile, 'utf8').trim();
    if (existing) return existing;
  }
  const installId = randomBytes(24).toString('base64url');
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(paths.installIdFile, `${installId}\n`, { mode: 0o600 });
  return installId;
}
