#!/usr/bin/env node
/**
 * One version, in the three places that ship it.
 *
 *   node tools/validate-version.mjs
 *
 * The number a restaurant sees in its console, the number on the zip it
 * downloaded, and the number Android shows in Settings → Apps have to be the
 * same number, or a support conversation starts with working out which one the
 * person is reading. They live apart because each is read by a different tool —
 * npm, TypeScript, Gradle — so this is what keeps them together.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path) => readFileSync(resolve(path), 'utf8');

const npmVersion = JSON.parse(read('package.json')).version;
const appVersion = read('packages/shared/src/index.ts')
  .match(/APP_VERSION = '([^']+)'/)?.[1];
const androidVersion = read('packaging/android/app/build.gradle.kts')
  .match(/versionName = "([^"]+)"/)?.[1];

const found = {
  'package.json': npmVersion,
  'packages/shared/src/index.ts (APP_VERSION)': appVersion,
  'packaging/android/app/build.gradle.kts (versionName)': androidVersion,
};

const distinct = [...new Set(Object.values(found))];
for (const [where, version] of Object.entries(found)) {
  if (distinct.length > 1) console.error(`  ${version ?? '(not found)'}  ${where}`);
}

if (distinct.length === 1 && distinct[0]) {
  console.log(`version ${distinct[0]}: agreed in ${Object.keys(found).length} places`);
  process.exit(0);
}
console.error('✗ the product version disagrees with itself');
process.exit(1);
