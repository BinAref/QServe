#!/usr/bin/env node
/**
 * Machine-name validator.
 *
 *   node tools/validate-audit-labels.mjs [locales-dir]
 *
 * Two places in the console render names the *code* chose rather than names a
 * person wrote: the activity log (`menu.product_created`) and the operational
 * settings (`orders.autoAcceptFromCustomer`). Both are read by a restaurant
 * owner, so both must have a sentence in the reference language.
 *
 * They are string literals at their call sites — deliberately, it keeps each
 * module readable — so this reads them back out of the source. A module added
 * later has its labels demanded here rather than discovered by an owner
 * staring at a screen full of identifiers.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REFERENCE = 'en';
const localesDir = resolve(process.argv[2] ?? 'locales');
const serverSrc = resolve('apps/server/src');

/** Every `action: 'x.y'`, `log(ctx, 'x.y'`, `record(ctx, 'x.y'` in the source. */
const PATTERNS = [
  /\baction:\s*'([a-z][a-z0-9_.]*)'/g,
  /\baction:\s*[^'\n]*\?\s*'([a-z][a-z0-9_.]*)'\s*:\s*'([a-z][a-z0-9_.]*)'/g,
  /\b(?:log|record)\(\s*ctx\s*,\s*'([a-z][a-z0-9_.]*)'/g,
];

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
  }
})(serverSrc);

const actions = new Set();
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      for (const captured of match.slice(1)) if (captured) actions.add(captured);
    }
  }
}

const pack = JSON.parse(readFileSync(join(localesDir, `${REFERENCE}.json`), 'utf8'));
const strings = pack.strings ?? {};

/* --------------------------------------------------------------- settings */

/** `orders.autoAcceptFromCustomer` → `setting.orders.auto_accept_from_customer`. */
const settingKey = (key) => {
  const [group, ...rest] = key.split('.');
  return `setting.${group}.${rest.join('.').replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()}`;
};

/* Credentials and machine-managed caches; the console never renders these. */
const HIDDEN_SETTINGS = ['backup.passphrase', 'security.', 'license.'];

const settingsSource = readFileSync(
  resolve('apps/server/src/core/repositories/settings.ts'), 'utf8',
);
const defaults = settingsSource.slice(settingsSource.indexOf('DEFAULT_SETTINGS'));
const settingKeys = [...defaults.matchAll(/'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)':/g)]
  .map((match) => match[1])
  .filter((key) => !HIDDEN_SETTINGS.some((prefix) => key.startsWith(prefix)));

const missingSettings = settingKeys.filter((key) => !(settingKey(key) in strings));
const missingHints = settingKeys.filter((key) => !(`${settingKey(key)}.hint` in strings));
for (const key of missingSettings) console.error(`✗ no label for setting: ${key}`);
for (const key of missingHints) console.error(`✗ no explanation for setting: ${key}`);

const missing = [...actions].filter((action) => !(`audit.action.${action}` in strings)).sort();
const orphan = Object.keys(strings)
  .filter((key) => key.startsWith('audit.action.'))
  .map((key) => key.slice('audit.action.'.length))
  .filter((action) => !actions.has(action))
  .sort();

for (const action of missing) console.error(`✗ no label for recorded action: ${action}`);
for (const action of orphan) console.error(`✗ label for an action nothing records: ${action}`);

const issues = missing.length + orphan.length + missingSettings.length + missingHints.length;
console.log(
  `${actions.size} audited action(s), ${settingKeys.length} setting(s): ${issues} issue(s)`,
);
process.exit(issues > 0 ? 1 : 0);
