#!/usr/bin/env node
/**
 * Is there a character in a text file that nobody typed on purpose?
 *
 *   node tools/validate-control-characters.mjs
 *
 * A vertical tab — 0x0B — got into `.github/workflows/release.yml`, where it
 * had been a backslash a moment earlier. GitHub then refused to parse the
 * workflow, which it does not report as an error: the workflow simply stops
 * having a `workflow_dispatch` trigger, and the only symptom is a dispatch
 * that will not run. It cost a release to find.
 *
 * The same character in a Dart or TypeScript string would compile, ship, and
 * turn up in whatever a restaurant is looking at. Nothing in this repository
 * has any use for a control character other than tab, newline and carriage
 * return, so anything else is a mistake on the way in.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOTS = ['apps', 'packages', 'tools', 'supabase', 'locales', 'docs', '.github', 'packaging'];

const TEXT = /\.(ts|tsx|js|mjs|cjs|dart|kt|java|sql|html|css|json|yml|yaml|md|txt|xml|kts|properties)$/;

const SKIP = new Set([
  'node_modules', 'dist', 'build', '.dart_tool', '.gradle', '.kotlin', '.idea',
  'ephemeral', 'Release', 'Debug', '.plugin_symlinks',
]);

/** Tab, newline and carriage return are the three a person means. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

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
      else if (TEXT.test(entry.name)) files.push(path);
    }
  })(start);
}

const found = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // C0 and the DEL/C1 range, which is where the invisible mistakes live.
    const bad = (code < 0x20 && !ALLOWED.has(code)) || code === 0x7f;
    if (!bad) continue;

    const line = text.slice(0, i).split('\n').length;
    found.push({
      file: relative(process.cwd(), file),
      line,
      code: '0x' + code.toString(16).padStart(2, '0'),
    });
    break; // One per file is enough to send somebody to look.
  }
}

for (const { file, line, code } of found) {
  console.error(`✗ ${file}:${line} holds ${code}, which nobody types on purpose`);
}

console.log(found.length === 0
  ? `${files.length} text file(s): no stray control characters`
  : `✗ ${found.length} file(s) hold a character that will break a parser somewhere`);

process.exit(found.length === 0 ? 0 : 1);
