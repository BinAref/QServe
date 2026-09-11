#!/usr/bin/env node
/**
 * The restaurant's own server, as one file.
 *
 *   node packaging/restaurant/build.mjs [--node-version 22.x.y] [--no-pack]
 *
 * Produces `dist/restaurant/QServe-<version>-windows-x64.exe`. This is what a
 * restaurant downloads: the server, the console, the six front-ends, the
 * language and theme packs and a native SQLite, all inside one executable that
 * unpacks itself on first run. Nothing to unzip, no installer, no window.
 *
 * Run it on Windows: `better-sqlite3` is native, and the copy baked in has to be
 * the Windows one. The release workflow does exactly that.
 */

import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
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
/** Stage the folder but bake no executable. For checking the layout. */
const noPack = argv.includes('--no-pack');

say('preparing');
rmSync(build, { recursive: true, force: true });
const app = join(stage, 'app');
mkdirSync(app, { recursive: true });

/* -------------------------------------------- the dependencies, installed first */

const serverPackage = JSON.parse(readFileSync(join(repo, 'apps/server/package.json'), 'utf8'));
const dbPackage = JSON.parse(readFileSync(join(repo, 'packages/db/package.json'), 'utf8'));
const dependencies = Object.fromEntries(
  Object.entries({ ...serverPackage.dependencies, ...dbPackage.dependencies })
    .filter(([name]) => !name.startsWith('@qserve/'))
    .sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(join(app, 'package.json'), `${JSON.stringify({
  name: 'qserve-app', version, private: true, type: 'module', dependencies,
}, null, 2)}\n`);

say('installing runtime dependencies');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app });

say('staging the workspace packages');
stageWorkspacePackages(repo, app, ['shared', 'crypto', 'http', 'db']);

/* ----------------------------------------------------------------- the app */

say('staging the app');
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
let activatable = existsSync(trustStore);
if (activatable) {
  cpSync(trustStore, join(app, 'server/config/trusted-keys.json'));
  // A file with no keys in it is not a trust store; it is a placeholder.
  const keys = JSON.parse(readFileSync(trustStore, 'utf8')).keys ?? {};
  activatable = Object.keys(keys).length > 0;
}
if (!activatable) {
  cpSync(join(repo, 'apps/server/config/trusted-keys.example.json'),
    join(app, 'server/config/trusted-keys.json'));
  process.stdout.write(
    '\n  ! no vendor public keys — shipping the example trust store.\n'
    + '    Nothing this build produces can be activated. Set QSERVE_TRUSTED_KEYS\n'
    + '    in the release workflow, or run `npm run keygen` before building.\n',
  );
}

/*
 * And the vendor's own name, prices and contacts. Not secret, and not required
 * — but without it a restaurant that has never been online has no way to know
 * who to ask for a licence, which is a strange thing to ship.
 */
const vendorFile = join(repo, 'apps/server/config/vendor.json');
if (existsSync(vendorFile)) {
  cpSync(vendorFile, join(app, 'server/config/vendor.json'));
} else {
  process.stdout.write(
    '\n  ! no apps/server/config/vendor.json — this build shows "ask us" with\n'
    + '    nobody to ask until it reaches a licence server. Prepare it in the\n'
    + "    console's Developer section, or set QSERVE_VENDOR_INFO in the workflow.\n",
  );
}

/*
 * Where this build asks for a licence.
 *
 * The licence server is no longer a machine the vendor keeps switched on; it is
 * a URL that never changes. Shipping it here is the difference between a
 * restaurant that can activate by typing its key and one that must first be
 * told to set an environment variable — which is not a thing a restaurant will
 * ever do, and would be our fault for asking.
 *
 * It stays overridable: a real `QSERVE_LICENSE_SERVER_URL` in the environment
 * still wins, which is what makes a staging server possible at all.
 */
const vendorUrl = (process.env.QSERVE_VENDOR_URL ?? '').trim().replace(/\/+$/, '');
if (vendorUrl) {
  writeFileSync(join(app, 'server/config/license-server.json'),
    `${JSON.stringify({ url: vendorUrl }, null, 2)}
`);
} else {
  process.stdout.write(
    '
  ! no QSERVE_VENDOR_URL — this build does not know where to ask for a
'
    + '    licence, and a restaurant running it will not be able to activate.
',
  );
}

cpSync(join(repo, 'apps/web'), join(app, 'web'), { recursive: true });
cpSync(join(repo, 'locales'), join(stage, 'locales'), { recursive: true });
cpSync(join(repo, 'themes'), join(stage, 'themes'), { recursive: true });

checkPayload(stage, [
  'app/server/dist/main.js',
  'app/node_modules/@qserve/shared/dist/index.js',
  'app/node_modules/@qserve/crypto/dist/index.js',
  'app/node_modules/@qserve/http/dist/index.js',
  'app/node_modules/@qserve/db/dist/index.js',
  'app/node_modules/better-sqlite3/package.json',
  'app/web/console/index.html',
]);

// `better-sqlite3` is native. Built anywhere but Windows, the executable would
// look perfect and fail on the first launch, so say so rather than ship it.
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

const exe = join(repo, 'dist/restaurant', `QServe-${version}-windows-x64.exe`);
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
  `\n  ${activatable ? '' : '! carries no vendor keys: setup mode only.\n  '}`
  + 'One file. Download it, run it, no unzipping and no window.\n',
);
