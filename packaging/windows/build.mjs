#!/usr/bin/env node
/**
 * Build the Windows release: one file, `dist/QServe-<version>-windows-x64.exe`.
 *
 *   node packaging/windows/build.mjs [--node-version 22.x.y] [--no-pack]
 *
 * There is nothing to unzip and nothing to install. The whole product — the
 * server, the six front-ends, the language packs, the themes, the native SQLite
 * — is packed into a ZIP, the ZIP is baked into a copy of the Node runtime as a
 * SEA asset, and the launcher inside unpacks it into %LOCALAPPDATA%\QServe on
 * first run. An owner downloads a file from the releases page and runs it.
 *
 * Two things this build does that are easy to miss and expensive to get wrong:
 *
 *   The workspace packages are copied in AFTER `npm install`. npm reifies
 *   node_modules to match package.json and deletes anything extraneous, so a
 *   `@qserve/shared` staged before the install is staged into the bin — which
 *   is exactly how a build that looked perfect shipped an executable that died
 *   on launch saying it could not find `@qserve/shared`.
 *
 *   The executable is re-marked as a GUI program. A copy of node.exe is a
 *   console program, and Windows gives every console program a black window
 *   whether or not anything is written to it. A till is not a terminal.
 *
 * Run it on Windows: `better-sqlite3` is native, and the copy baked into the
 * executable has to be the Windows one. The release workflow does exactly that.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { argv, platform } from 'node:process';
import { makeZip } from './zip.mjs';

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
/** Stage the folder but do not bake an executable. For checking the layout. */
const noPack = argv.includes('--no-pack');

/*
 * Run a tool. On Windows `npm` and `npx` are `.cmd` files, which cannot be
 * spawned directly — hence the shell — and going through a shell means the
 * arguments have to be quoted ourselves, because a build machine may well have
 * a space in its path.
 */
const run = (command, args, options = {}) => {
  process.stdout.write(`  $ ${command} ${args.join(' ')}\n`);
  const shell = platform === 'win32';
  // The command needs the same treatment as its arguments. Node itself lives
  // under "C:\Program Files" on a normal Windows install, and unquoted that is
  // a command called `C:\Program` with a stray argument after it.
  const quote = (value) => (/[\s&|<>^]/.test(value) ? `"${value}"` : value);
  const quoted = shell ? args.map(quote) : args;
  return execFileSync(shell ? quote(command) : command, quoted,
    { stdio: 'inherit', shell, ...options });
};
const say = (message) => process.stdout.write(`\n▸ ${message}\n`);

/* ------------------------------------------------------------------ clean */

say('preparing');
rmSync(build, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const app = join(stage, 'app');
mkdirSync(app, { recursive: true });

/*
 * Type declarations and source maps are for whoever builds QServe, not for the
 * restaurant running it; the tests are neither, and a restaurant should never
 * be shipped code that mints its own activation certificates.
 */
const shippable = (source) =>
  !source.includes(`${sep}dist${sep}tests`)
  && !source.endsWith('.d.ts') && !source.endsWith('.d.ts.map') && !source.endsWith('.js.map');

/* -------------------------------------------- the dependencies, installed first */

/*
 * ORDER MATTERS. `npm install` deletes everything in node_modules that its
 * package.json does not ask for, and the workspace packages are deliberately
 * not in that list — they are copied, not fetched. So the install runs against
 * an empty tree, and `@qserve/*` goes in afterwards where npm cannot prune it.
 */
const serverPackage = JSON.parse(readFileSync(join(repo, 'apps/server/package.json'), 'utf8'));
const dbPackage = JSON.parse(readFileSync(join(repo, 'packages/db/package.json'), 'utf8'));
const dependencies = Object.fromEntries(
  Object.entries({ ...serverPackage.dependencies, ...dbPackage.dependencies })
    .filter(([name]) => !name.startsWith('@qserve/'))
    .sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(join(app, 'package.json'), `${JSON.stringify({
  name: 'qserve-app',
  version,
  private: true,
  type: 'module',
  dependencies,
}, null, 2)}\n`);

say('installing runtime dependencies');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app });

say('staging the workspace packages');
// Copied rather than linked: a junction does not survive being zipped, and a
// restaurant with a broken tree has no way to know what went wrong.
for (const name of ['shared', 'crypto', 'http', 'db']) {
  const from = join(repo, 'packages', name);
  const to = join(app, 'node_modules/@qserve', name);
  cpSync(join(from, 'dist'), join(to, 'dist'), { recursive: true, filter: shippable });
  cpSync(join(from, 'package.json'), join(to, 'package.json'));
}

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

cpSync(join(repo, 'apps/web'), join(app, 'web'), { recursive: true });
cpSync(join(repo, 'locales'), join(stage, 'locales'), { recursive: true });
cpSync(join(repo, 'themes'), join(stage, 'themes'), { recursive: true });

/* ------------------------------------------------------- check before baking */

/*
 * The build has been wrong before in a way that only showed up on a
 * restaurant's computer, so the things whose absence is fatal are checked here,
 * where the failure costs a rebuild instead of a phone call.
 */
say('checking the payload');
const required = [
  'app/server/dist/main.js',
  'app/node_modules/@qserve/shared/dist/index.js',
  'app/node_modules/@qserve/crypto/dist/index.js',
  'app/node_modules/@qserve/http/dist/index.js',
  'app/node_modules/@qserve/db/dist/index.js',
  'app/node_modules/better-sqlite3/package.json',
  'app/web/console/index.html',
];
const missing = required.filter((path) => !existsSync(join(stage, path)));
if (missing.length > 0) {
  throw new Error(`the payload is incomplete:\n  ${missing.join('\n  ')}`);
}
process.stdout.write(`  ${required.length} required paths present\n`);

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

/* --------------------------------------------------------------- the payload */

say('packing the payload');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});
// Sorted, so two builds of the same source produce the same archive and a
// release can be checked by rebuilding it.
const files = walk(stage).sort();
const payload = makeZip(files.map((file) => [
  relative(stage, file).split(sep).join('/'),
  readFileSync(file),
]));
const payloadFile = join(build, 'payload.zip');
writeFileSync(payloadFile, payload);
process.stdout.write(
  `  ${files.length} files, ${(payload.length / 1024 / 1024).toFixed(1)} MB compressed\n`,
);

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

/* ------------------------------------------------------------ the executable */

say('building QServe.exe');
run(process.execPath, ['--experimental-sea-config', join(here, 'sea-config.json')], { cwd: here });

const distDir = join(repo, 'dist');
mkdirSync(distDir, { recursive: true });
const exe = join(distDir, `QServe-${version}-windows-x64.exe`);
rmSync(exe, { force: true });
cpSync(nodeExe, exe);

run('npx', ['--yes', 'postject', exe, 'NODE_SEA_BLOB', join(build, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { cwd: here });

/* ------------------------------------------------------------ no black window */

/**
 * Re-mark the executable as a GUI program.
 *
 * A copy of node.exe is a console program, and Windows opens a console window
 * for one of those before a single line of our code runs — there is no flag,
 * no argument and no API that prevents it from the inside. The only thing that
 * decides it is one 16-bit field in the PE header, and this rewrites it: 3
 * (Windows CUI) becomes 2 (Windows GUI).
 *
 * The field sits at a fixed offset in the optional header, the same offset for
 * both 32- and 64-bit images, because the fields that differ between them are
 * all before it and cancel out. The header checksum is left stale, as postject
 * leaves it: Windows verifies it for drivers, not for programs.
 */
function markAsGuiProgram(file) {
  const image = readFileSync(file);
  if (image.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file} is not a PE image`);

  const peHeader = image.readUInt32LE(0x3c);
  if (image.readUInt32LE(peHeader) !== 0x00004550) throw new Error(`${file} has no PE signature`);

  const optionalHeader = peHeader + 24;
  const magic = image.readUInt16LE(optionalHeader);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`${file}: unknown PE optional header`);

  const subsystemAt = optionalHeader + 68;
  const subsystem = image.readUInt16LE(subsystemAt);
  if (subsystem === 2) return 'already a GUI program';
  if (subsystem !== 3) throw new Error(`${file}: unexpected subsystem ${subsystem}`);

  image.writeUInt16LE(2, subsystemAt);
  writeFileSync(file, image);
  return 'console subsystem 3 → GUI subsystem 2';
}

say('removing the console window');
process.stdout.write(`  ${markAsGuiProgram(exe)}\n`);

const megabytes = (statSync(exe).size / 1024 / 1024).toFixed(0);
say(`done: ${basename(exe)} (${megabytes} MB)`);
process.stdout.write(
  `\n  ${activatable ? '' : '! carries no vendor keys: setup mode only.\n  '}`
  + 'One file. Download it, run it, no unzipping and no window.\n',
);
