#!/usr/bin/env node
/**
 * The vendor's licence server, as one file.
 *
 *   node packaging/developer/build.mjs [--node-version 22.x.y] [--no-pack]
 *
 * Produces `dist/developer/QServe-Vendor-<version>-windows-x64.exe`. This is
 * the half of the product a restaurant never sees: it issues the licence keys
 * they type in, verifies them, and holds the record of who bought what.
 *
 * It had no packaged form at all until now — running it meant cloning the
 * repository and knowing which npm script to type, which is a strange thing to
 * ask of the person whose whole job is selling the software. Same technique as
 * the restaurant's executable, and the same reasons: one file, no window.
 *
 * Unlike the restaurant build this one is not tied to Windows by a native
 * dependency — the licence server uses the same SQLite, so it is, but the
 * reason to run the build on Windows is identical: the compiled module baked in
 * has to be the Windows one.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { argv, platform } from 'node:process';

import {
  buildExecutable, checkPayload, run, say, shippable, stageWorkspacePackages,
} from '../lib/windows-exe.mjs';

const repo = resolve(import.meta.dirname, '../..');
const here = resolve(import.meta.dirname);
const build = join(here, 'build');
const stage = join(build, 'payload');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;

const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const nodeVersion = flag('node-version', process.version.replace(/^v/, ''));
const noPack = argv.includes('--no-pack');

say('preparing');
rmSync(build, { recursive: true, force: true });
const app = join(stage, 'app');
mkdirSync(app, { recursive: true });

/* -------------------------------------------- the dependencies, installed first */

/*
 * ORDER MATTERS — `npm install` deletes anything in node_modules its
 * package.json does not ask for, and the workspace packages are deliberately
 * not in that list. See `stageWorkspacePackages`.
 */
const dbPackage = JSON.parse(readFileSync(join(repo, 'packages/db/package.json'), 'utf8'));
const dependencies = Object.fromEntries(
  Object.entries({ ...dbPackage.dependencies })
    .filter(([name]) => !name.startsWith('@qserve/'))
    .sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(join(app, 'package.json'), `${JSON.stringify({
  name: 'qserve-vendor', version, private: true, type: 'module', dependencies,
}, null, 2)}\n`);

say('installing runtime dependencies');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app });

say('staging the workspace packages');
stageWorkspacePackages(repo, app, ['shared', 'crypto', 'http', 'db']);

/* ----------------------------------------------------------------- the app */

say('staging the licence server');
cpSync(join(repo, 'apps/license-server/dist'), join(app, 'license-server/dist'), {
  recursive: true, filter: shippable,
});
/*
 * The vendor console, and the keygen beside it.
 *
 * `dist/tools/keygen.js` is deliberately kept: the launcher calls it on first
 * run to make the vendor's signing key. It is the one piece of code that must
 * never reach a restaurant's build and must always be in this one.
 */
cpSync(join(repo, 'apps/license-server/public'), join(app, 'license-server/public'), {
  recursive: true,
});

checkPayload(stage, [
  'app/license-server/dist/main.js',
  'app/license-server/dist/tools/keygen.js',
  'app/license-server/public/index.html',
  'app/node_modules/@qserve/shared/dist/index.js',
  'app/node_modules/@qserve/crypto/dist/index.js',
  'app/node_modules/@qserve/http/dist/index.js',
  'app/node_modules/@qserve/db/dist/index.js',
  'app/node_modules/better-sqlite3/package.json',
]);

if (platform !== 'win32') {
  process.stdout.write(
    `\n  ! built on ${platform}: node_modules holds this platform's native\n`
    + "    SQLite, not Windows's. Good for checking the layout, not for release.\n",
  );
}

if (noPack) {
  say(`done: ${stage}`);
  process.exit(0);
}

const exe = join(repo, 'dist/developer', `QServe-Vendor-${version}-windows-x64.exe`);
const { megabytes } = await buildExecutable({
  build,
  stage,
  launcher: join(here, 'launcher.js'),
  exe,
  nodeVersion,
  mustContain: ['better_sqlite3.node'],
});

say(`done: ${basename(exe)} (${megabytes} MB)`);
process.stdout.write(
  '\n  This one is yours, not a restaurant\'s. It makes its own signing key on\n'
  + '  first run and tells you where — back that file up the same day.\n',
);
