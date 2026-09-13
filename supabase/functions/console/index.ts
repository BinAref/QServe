/**
 * Serving the vendor console.
 *
 * The whole reason this is an Edge Function rather than a file on somebody's
 * machine: the vendor has one address, it is always up, and the phone app and
 * the laptop open the same thing. Nothing to install, nothing to keep running,
 * nothing to forget to switch on before a customer calls.
 *
 * It hands out a page and the project's *publishable* key. That key is public
 * by design — it is what every Supabase browser client ships — and on its own
 * it opens nothing: the tables are behind row level security, and access needs
 * an account that is named in `vendor_admins`.
 */

import { CONSOLE_PAGE } from './page.ts';

const PROJECT_URL = (Deno.env.get('QSERVE_PROJECT_URL')
  ?? Deno.env.get('SUPABASE_URL') ?? '').trim().replace(/\/+$/, '');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

Deno.serve(() => {
  if (!PROJECT_URL || !ANON_KEY) {
    return new Response('the console is not configured', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(CONSOLE_PAGE({ url: PROJECT_URL, anonKey: ANON_KEY }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached: the console is one file, and a stale copy of it is a
      // vendor looking at last week's idea of what the buttons do.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      /*
       * The page talks to exactly two places, both this project: PostgREST for
       * the licence tables and GoTrue for signing in. Everything else is
       * refused, so an injected string cannot become an exfiltration route
       * even if one ever gets past the node-building above.
       */
      'content-security-policy': [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        `connect-src ${PROJECT_URL}`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  });
});
