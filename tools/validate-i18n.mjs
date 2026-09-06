#!/usr/bin/env node
/**
 * Language pack validator (spec §32).
 *
 *   node tools/validate-i18n.mjs [--strict] [locales-dir]
 *
 * Checks every pack for missing, invalid, duplicate and unsupported keys, plus
 * placeholder mismatches against the reference locale. Run it in CI: a broken
 * translation should fail a build, not a dinner service.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  hasBlockingIssues, validateLocalePack,
} from '../packages/shared/dist/index.js';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? 'locales');
const REFERENCE = 'en';

const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort(
  (a, b) => (a === `${REFERENCE}.json` ? -1 : b === `${REFERENCE}.json` ? 1 : a.localeCompare(b)),
);

let reference = null;
let errors = 0;
let warnings = 0;

for (const file of files) {
  const path = join(dir, file);
  const raw = readFileSync(path, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`✗ ${file}: invalid JSON — ${error.message}`);
    errors += 1;
    continue;
  }

  const isReference = basename(file, '.json') === REFERENCE;
  const issues = validateLocalePack(parsed, {
    rawSource: raw,
    ...(reference && !isReference ? { reference } : {}),
    strictCoverage: strict,
  });

  if (isReference && !hasBlockingIssues(issues)) reference = parsed;

  const fileErrors = issues.filter((i) => i.severity === 'error');
  const fileWarnings = issues.filter((i) => i.severity === 'warning');
  errors += fileErrors.length;
  warnings += fileWarnings.length;

  const coverage = reference
    ? Math.round(
        (Object.keys(parsed.strings ?? {}).length / Object.keys(reference.strings).length) * 100,
      )
    : 100;

  if (fileErrors.length === 0) {
    console.log(`✓ ${file}  ${Object.keys(parsed.strings ?? {}).length} keys, ${coverage}% coverage` +
      (fileWarnings.length ? `, ${fileWarnings.length} warning(s)` : ''));
  } else {
    console.error(`✗ ${file}  ${fileErrors.length} error(s)`);
  }

  for (const issue of [...fileErrors, ...fileWarnings].slice(0, 25)) {
    const marker = issue.severity === 'error' ? '   ✗' : '   ·';
    console.error(`${marker} [${issue.kind}] ${issue.key ?? ''} ${issue.detail}`);
  }
  if (issues.length > 25) console.error(`   … and ${issues.length - 25} more`);
}

console.log(`\n${files.length} locale(s): ${errors} error(s), ${warnings} warning(s)`);
process.exitCode = errors > 0 ? 1 : 0;
