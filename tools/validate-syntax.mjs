#!/usr/bin/env node
/**
 * Does every hand-written script in this repository actually parse?
 *
 *   node tools/validate-syntax.mjs
 *
 * `tsc --build` covers the server and the packages. It covers nothing else,
 * and "nothing else" is most of what a restaurant runs: the five front-end
 * applications are plain ES modules served straight off disk with no build
 * step, and the packaging scripts are plain Node.
 *
 * A syntax error in either is invisible until the moment it matters. One in
 * `packaging/restaurant/build.mjs` passed `npm run check`, passed review, and
 * failed the release build — after the version had been bumped, tagged and
 * pushed. One in a front-end file would be worse: it would ship, and the first
 * person to meet it would be a cashier on a Friday night looking at a blank
 * screen.
 *
 * `node --check` is the whole test. It is not type checking and does not
 * pretend to be; it answers the one question that has actually bitten.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const roots = ['apps/web', 'packaging', 'tools'];
const SKIP = new Set(['node_modules', 'build', 'dist', '.gradle', 'payload']);

const files = [];
for (const root of roots) {
  (function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a directory that only exists after a build
    }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(mjs|cjs|js)$/.test(entry)) files.push(path);
    }
  })(resolve(root));
}

const broken = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    const message = String(error.stderr ?? error.message)
      .split('\n')
      .filter((line) => line.includes('Error') || line.includes('^'))
      .slice(0, 2)
      .join(' ')
      .trim();
    broken.push({ file: relative(process.cwd(), file), message });
  }
}

for (const { file, message } of broken) console.error(`✗ ${file}: ${message}`);

console.log(broken.length === 0
  ? `${files.length} script(s): 0 issue(s)`
  : `✗ ${broken.length} of ${files.length} script(s) do not parse`);
process.exit(broken.length === 0 ? 0 : 1);
