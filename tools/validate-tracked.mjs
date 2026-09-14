#!/usr/bin/env node
/**
 * Is every source file in this repository actually in this repository?
 *
 *   node tools/validate-tracked.mjs
 *
 * A `.gitignore` rule with no leading slash matches at every depth. `data/`
 * was written for the server's own data directory at the root and quietly
 * swallowed `apps/vendor/lib/data/` — the whole data layer of the vendor
 * application: its API client, its keystore, its attempt counter, its licence
 * keys. Everything built and every test passed, because all of it was on this
 * machine. The commit went out without it.
 *
 * That is not a mistake a build catches, because the build runs before the
 * commit and on a machine where the files exist. It is caught in one place:
 * by asking git what it can actually see.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Where source lives, as opposed to where output and dependencies live. */
const ROOTS = ['apps', 'packages', 'tools', 'supabase'];

const SOURCE = /\.(ts|tsx|js|mjs|cjs|dart|kt|java|sql|html|css|json)$/;

/** Directories that are output or machinery, and are ignored on purpose. */
const SKIP = new Set([
  'node_modules', 'dist', 'build', '.dart_tool', '.gradle', '.kotlin', '.idea',
  'ephemeral', 'Release', 'Debug', '.plugin_symlinks',
]);

/**
 * Files written by a toolchain or a secret on every build. These are supposed
 * to be invisible; everything else being invisible is the bug this looks for.
 */
const DELIBERATE = [
  // From supabase/project.json and QSERVE_VENDOR_EMAIL.
  /apps\/vendor\/lib\/config\.dart$/,
  // From QSERVE_VENDOR_INFO and QSERVE_TRUSTED_KEYS.
  /apps\/server\/config\/(vendor|trusted-keys)\.json$/,
  // Written by the toolchains themselves.
  /\/GeneratedPluginRegistrant\.java$/,
  /\/local\.properties$/,
];

const files = [];
for (const root of ROOTS) {
  let start;
  try {
    start = resolve(root);
    statSync(start);
  } catch {
    continue;
  }
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(entry.name)) files.push(relative(process.cwd(), path));
    }
  })(start);
}

/*
 * `check-ignore` answers for many paths at once and says nothing about the
 * ones it does not match, so what comes back is exactly the list of files git
 * has been told to pretend are not there.
 */
let ignored = [];
try {
  const answer = execFileSync('git', ['check-ignore', '--stdin'], {
    input: files.join('\n'),
    encoding: 'utf8',
  });
  ignored = answer.split('\n');
} catch (error) {
  // Exit code 1 means nothing matched, which is the answer this wants.
  if (error.status !== 1) {
    console.error('could not ask git what it ignores:', error.message);
    process.exit(1);
  }
}

/**
 * One shape, not two.
 *
 * On Windows git answers with backslashes, and quotes any path it considers
 * unusual. Comparing those against forward-slashed patterns is how a check
 * like this reports four failures that are all the same non-failure.
 */
const tidy = (line) => line
  .trim()
  .replace(/^"|"$/g, '')
  .replace(/\\\\/g, '\\')
  .split('\\')
  .join('/');

const missing = ignored
  .map(tidy)
  .filter(Boolean)
  .filter((file) => !DELIBERATE.some((allowed) => allowed.test(file)));

for (const file of missing) {
  console.error(`✗ ${file} is source, and git has been told to ignore it`);
}

console.log(missing.length === 0
  ? `${files.length} source file(s): all visible to git`
  : `✗ ${missing.length} source file(s) would not survive a fresh clone`);

process.exit(missing.length === 0 ? 0 : 1);
