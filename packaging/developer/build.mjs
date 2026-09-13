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
  buildExecutable, checkPayload, run, say, shippable,
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
mkdirSync(stage, { recursive: true });

/* ------------------------------------------------------------- the console */

/*
 * One file, and nothing else.
 *
 * There is no server here any more, so there is no application to install, no
 * workspace package to stage and no native SQLite to carry. What used to be an
 * 84 MB download of a database engine is a page that talks to Supabase.
 */
say('building the vendor console');
run(process.execPath, [join(repo, 'tools/build-console.mjs'), join(stage, 'console.html')],
  { cwd: repo });

checkPayload(stage, ['console.html']);

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
  // There is one file in this payload, and an executable that unpacks to
  // nothing would open a browser at a page that is not there.
  mustContain: ['console.html'],
});

say(`done: ${basename(exe)} (${megabytes} MB)`);
process.stdout.write(
  '\n  This one is yours, not a restaurant\'s. It makes its own signing key on\n'
  + '  first run and tells you where — back that file up the same day.\n',
);
