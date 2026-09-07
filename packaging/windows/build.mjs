#!/usr/bin/env node
/**
 * Build the Windows bundle.
 *
 *   node packaging/windows/build.mjs [--node-version 22.x.y]
 *
 * Produces `dist/QServe-<version>-windows-x64.zip`, a folder an owner unzips
 * and runs. There is no installer and nothing is written outside it except the
 * restaurant's own data, which goes to %LOCALAPPDATA%\QServe.
 *
 * The layout mirrors the repository on purpose, so the server's own defaults
 * find the web root, the language packs and the trust store without the
 * launcher having to say where anything is:
 *
 *   QServe.exe            the Node runtime with the launcher baked in, which
 *                         then loads the server below — one executable, no
 *                         installer, nothing on the machine outside this folder
 *   app/server/dist       the server
 *   app/server/config     the vendor public keys — and only the public ones
 *   app/web               the six front-ends, served over the LAN
 *   app/node_modules      three runtime dependencies, plus the workspace packages
 *   locales/ themes/      the packs the product ships with
 *
 * Run it on Windows: `better-sqlite3` is native, and the copy that ends up in
 * the zip has to be the Windows one. The release workflow does exactly that.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { argv, platform } from 'node:process';

const repo = resolve(import.meta.dirname, '../..');
const here = resolve(import.meta.dirname);
const build = join(here, 'build');
const stage = join(build, 'QServe');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;

const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const nodeVersion = flag('node-version', process.version.replace(/^v/, ''));
const skipZip = argv.includes('--no-zip');

const run = (command, args, options = {}) => {
  process.stdout.write(`  $ ${command} ${args.join(' ')}\n`);
  return execFileSync(command, args, { stdio: 'inherit', ...options });
};
const say = (message) => process.stdout.write(`\n▸ ${message}\n`);

/* ------------------------------------------------------------------ clean */

say('preparing');
rmSync(build, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

/* ------------------------------------------------- the runtime to ship on */

say(`fetching node ${nodeVersion} for windows-x64`);
const nodeZip = join(build, `node-v${nodeVersion}-win-x64.zip`);
const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`;

const response = await fetch(nodeUrl);
if (!response.ok) throw new Error(`${nodeUrl} → ${response.status}`);
writeFileSync(nodeZip, Buffer.from(await response.arrayBuffer()));

// Unzip with whatever this machine has: PowerShell on Windows, unzip elsewhere.
if (platform === 'win32') {
  run('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -Path '${nodeZip}' -DestinationPath '${build}' -Force`]);
} else {
  run('unzip', ['-q', '-o', nodeZip, '-d', build]);
}
const nodeExe = join(build, `node-v${nodeVersion}-win-x64`, 'node.exe');
if (!existsSync(nodeExe)) throw new Error(`no node.exe in ${nodeUrl}`);

/* ---------------------------------------------------------- the launcher */

say('building QServe.exe');
run(process.execPath, ['--experimental-sea-config', join(here, 'sea-config.json')], { cwd: here });

const launcherExe = join(stage, 'QServe.exe');
cpSync(nodeExe, launcherExe);
run('npx', ['--yes', 'postject', launcherExe, 'NODE_SEA_BLOB', join(build, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { cwd: here });

/* ----------------------------------------------------------------- the app */

say('staging the app');
const app = join(stage, 'app');
mkdirSync(join(app, 'node_modules', '@qserve'), { recursive: true });

/*
 * Type declarations and source maps are for whoever builds QServe, not for the
 * restaurant running it; the tests are neither, and a restaurant should never
 * be shipped code that mints its own activation certificates.
 */
const shippable = (source) =>
  !source.includes(`${sep}dist${sep}tests`)
  && !source.endsWith('.d.ts') && !source.endsWith('.d.ts.map') && !source.endsWith('.js.map');

cpSync(join(repo, 'apps/server/dist'), join(app, 'server/dist'), {
  recursive: true, filter: shippable,
});

/*
 * The trust store: the vendor's **public** keys, and nothing else. It is what
 * lets this computer verify an activation certificate with the internet
 * unplugged. A build without it produces a QServe that cannot be activated at
 * all, which is worth saying out loud rather than discovering in a restaurant.
 */
mkdirSync(join(app, 'server/config'), { recursive: true });
const trustStore = join(repo, 'apps/server/config/trusted-keys.json');
if (existsSync(trustStore)) {
  cpSync(trustStore, join(app, 'server/config/trusted-keys.json'));
} else {
  cpSync(join(repo, 'apps/server/config/trusted-keys.example.json'),
    join(app, 'server/config/trusted-keys.json'));
  process.stdout.write(
    '\n  ! no apps/server/config/trusted-keys.json — shipping the example.\n'
    + '    Nothing this build issues can be activated. Set QSERVE_TRUSTED_KEYS\n'
    + '    in the release workflow, or run `npm run keygen` before building.\n',
  );
}
cpSync(join(repo, 'apps/web'), join(app, 'web'), { recursive: true });
cpSync(join(repo, 'locales'), join(stage, 'locales'), { recursive: true });
cpSync(join(repo, 'themes'), join(stage, 'themes'), { recursive: true });

// The workspace packages are copied rather than linked: a junction does not
// survive a zip, and a restaurant unzipping a broken tree has no way to know.
for (const name of ['shared', 'crypto', 'http', 'db']) {
  const from = join(repo, 'packages', name);
  const to = join(app, 'node_modules/@qserve', name);
  cpSync(join(from, 'dist'), join(to, 'dist'), { recursive: true, filter: shippable });
  cpSync(join(from, 'package.json'), join(to, 'package.json'));
}

// Exactly the three runtime dependencies the product has, installed fresh so
// the native one is built for the machine this zip is going to.
const serverPackage = JSON.parse(readFileSync(join(repo, 'apps/server/package.json'), 'utf8'));
const dbPackage = JSON.parse(readFileSync(join(repo, 'packages/db/package.json'), 'utf8'));
const dependencies = Object.fromEntries(
  Object.entries({ ...serverPackage.dependencies, ...dbPackage.dependencies })
    .filter(([name]) => !name.startsWith('@qserve/')),
);
writeFileSync(join(app, 'package.json'), `${JSON.stringify({
  name: 'qserve-app',
  version,
  private: true,
  type: 'module',
  dependencies,
}, null, 2)}\n`);

say('installing runtime dependencies');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app, shell: platform === 'win32' });

// `better-sqlite3` is native. Built anywhere but Windows, the zip would look
// perfect and fail on the first launch, so say so rather than ship it quietly.
if (platform !== 'win32') {
  process.stdout.write(
    '\n  ! built on ' + platform + ': node_modules holds this platform\'s native\n'
    + '    SQLite, not Windows\'s. Good for checking the layout, not for release.\n',
  );
}

/* -------------------------------------------------------------- the notes */

writeFileSync(join(stage, 'README.txt'), [
  `QServe ${version} — Local Restaurant Operating System`,
  '',
  'To start: double-click QServe.exe. The management console opens in your',
  'browser. Keep the window open while the restaurant is trading; closing it',
  'stops the server, and the table QR codes stop working until it is running',
  'again.',
  '',
  'Windows may warn that the publisher is unknown, because this build is not',
  'signed with a certificate. "More info" then "Run anyway" starts it.',
  '',
  'Your restaurant\'s data — menu, orders, licence — is kept in',
  '  %LOCALAPPDATA%\\QServe\\data',
  'and never inside this folder, so a new version can replace this folder',
  'without touching it. Back it up from the console: Backup.',
  '',
  'The console is reachable only from this computer. Tables and staff devices',
  'reach the restaurant server over your own Wi-Fi, and only once a licence has',
  'been activated.',
  '',
  'No part of QServe needs the internet to run a service.',
  '',
].join('\r\n'));

/* ----------------------------------------------------------------- the zip */

const distDir = join(repo, 'dist');
mkdirSync(distDir, { recursive: true });
const zip = join(distDir, `QServe-${version}-windows-x64.zip`);
rmSync(zip, { force: true });

if (!skipZip) {
  say(`packing ${basename(zip)}`);
  if (platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${stage}' -DestinationPath '${zip}' -Force`]);
  } else {
    run('zip', ['-qr', zip, 'QServe'], { cwd: build });
  }
}

say(`done: ${skipZip ? stage : zip}`);
