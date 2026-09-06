#!/usr/bin/env node
/**
 * Theme pack validator (spec §33).
 *
 *   node tools/validate-themes.mjs [themes-dir]
 *
 * A theme that defines every required token is guaranteed to render every
 * screen, so this check is what makes "drop in a JSON file" a safe way to add a
 * theme.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { REQUIRED_TOKENS, flattenTokens, validateThemePack } from '../packages/shared/dist/index.js';

const dir = resolve(process.argv[2] ?? 'themes');
const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();

let errors = 0;

for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (error) {
    console.error(`✗ ${file}: invalid JSON — ${error.message}`);
    errors += 1;
    continue;
  }

  const issues = validateThemePack(parsed);
  if (parsed.id !== basename(file, '.json')) {
    issues.push({ kind: 'SCHEMA', detail: `id "${parsed.id}" does not match the file name` });
  }

  const defined = Object.keys(flattenTokens(parsed.tokens ?? {})).length;

  if (issues.length === 0) {
    console.log(`✓ ${file}  ${parsed.colorScheme}, ${defined} tokens (${REQUIRED_TOKENS.length} required)`);
  } else {
    console.error(`✗ ${file}  ${issues.length} issue(s)`);
    for (const issue of issues.slice(0, 25)) {
      console.error(`   ✗ [${issue.kind}] ${issue.token ?? ''} ${issue.detail}`);
    }
    if (issues.length > 25) console.error(`   … and ${issues.length - 25} more`);
    errors += issues.length;
  }
}

console.log(`\n${files.length} theme(s): ${errors} issue(s)`);
process.exitCode = errors > 0 ? 1 : 0;
