#!/usr/bin/env node
/**
 * Write the vendor console out as one standalone HTML file.
 *
 *   node tools/build-console.mjs [destination]
 *
 * The console cannot be hosted on Supabase. Both places a project can serve
 * files from — Edge Functions and Storage — deliberately answer HTML with
 * `content-type: text/plain` and `content-security-policy: sandbox`, so the
 * page arrives as text and never runs. That is the right call on their part: a
 * page served from the project's own domain would be same-origin with the API,
 * and one injection in it would read every token the browser holds for that
 * origin.
 *
 * So the console ships *inside the vendor's own applications* instead — an
 * asset in the Android app, a file the desktop build opens. Which is a better
 * answer anyway: there is no page to host, nothing to keep online, and the
 * vendor's tools work the moment they are installed.
 *
 * One source of truth: the page comes from the same module the (now removed)
 * Edge Function used, and the project address comes from supabase/project.json.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { CONSOLE_PAGE } from '../supabase/functions/console/page.ts';

const project = JSON.parse(readFileSync(resolve('supabase/project.json'), 'utf8'));
const out = resolve(process.argv[2] ?? 'packaging/developer/console.html');

const html = CONSOLE_PAGE({ url: project.url, anonKey: project.anonKey });

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);

console.log(`vendor console -> ${out} (${Math.round(html.length / 1024)} KB)`);
