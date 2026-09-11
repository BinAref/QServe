/**
 * The licence server, as an Edge Function.
 *
 * This is the only address a restaurant ever calls, and it answers the same
 * four routes the Node licence server answered, at the same paths, with the
 * same JSON. That is deliberate: `apps/server/src/modules/licensing` was not
 * changed to move here. A restaurant is pointed at
 *
 *   https://<project>.supabase.co/functions/v1
 *
 * instead of at a machine in the vendor's office, and everything else about it
 * carries on as before — including every installation already in the field,
 * which keeps verifying certificates with the public keys it already ships.
 *
 * The division of labour is the interesting part:
 *
 *   Postgres decides.  Whether this licence may bind to this machine, whether
 *                      a transfer is owed, what the audit line says — all of it
 *                      is in `activate_license`, in one transaction, beside the
 *                      unique index that makes "one live device" true.
 *
 *   This function signs. It holds the vendor's Ed25519 private key, which the
 *                      database has never seen and a database backup therefore
 *                      cannot leak. Nothing else in the system can mint a
 *                      certificate.
 *
 * Unauthenticated by design. A restaurant activating for the first time has no
 * credentials to present — that is what activation is for — so the key's own
 * checksum and a rate limit are what stand in the way of a stranger, exactly as
 * before.
 */

import { hashToken, issueCertificate } from './crypto.ts';
import { normaliseLicenseKey } from './license-key.ts';

/*
 * Where this project's PostgREST lives.
 *
 * `SUPABASE_URL` is documented as being injected into every function and is
 * not injected into this one, which cost an afternoon: every route answered
 * "the licence server could not complete this request" because the base of
 * every query was the string "undefined". The request already carries the
 * answer — a function served at https://<project>.supabase.co/functions/v1/api
 * is a request whose origin is the project — so it is taken from there, with
 * the environment variable as an override for anyone running this behind
 * something else.
 */
/*
 * The key this function presents to PostgREST.
 *
 * Two generations of key live side by side. Older projects inject a
 * `service_role` JWT; newer ones — this one — issue `sb_secret_…` keys and
 * hand them over as `SUPABASE_SECRET_KEYS`, with the legacy JWT still present
 * in the environment but refused at the door with a 403. Preferring the new
 * shape and falling back to the old one keeps this function working on either,
 * which matters because the failure is silent: every route answers "could not
 * complete this request" and nothing says the key was the problem.
 */
function serviceKey(): string {
  const modern = Deno.env.get('SUPABASE_SECRET_KEYS') ?? '';
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        if (typeof first === 'string') return first;
        if (first && typeof first === 'object' && typeof first.api_key === 'string') {
          return first.api_key;
        }
      }
    } catch {
      // Not JSON: a bare key, or a comma-separated list of them.
      return modern.split(',')[0]!.trim();
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

const SERVICE_KEY = serviceKey();
const ENV_URL = Deno.env.get('SUPABASE_URL') ?? '';
let projectUrl = ENV_URL;
/** The vendor's private signing key. Set with `supabase secrets set`. */
const SIGNING_PRIVATE = Deno.env.get('QSERVE_SIGNING_PRIVATE_KEY') ?? '';
const SIGNING_PUBLIC = Deno.env.get('QSERVE_SIGNING_PUBLIC_KEY') ?? '';

const ACTIVATION_CERTIFICATE_VERSION = 1;

/** Kept in step with `LICENSED_CAPABILITIES` in packages/shared. */
const LICENSED_CAPABILITIES = [
  'tables.provision', 'terminals.provision', 'server.lan', 'orders.runtime',
  'kitchen.runtime', 'cashier.runtime', 'waiter.runtime', 'printing.runtime',
  'reports.runtime',
];

const DEVICE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/* ----------------------------------------------------------- responses */

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, apikey',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
  });

/**
 * The error envelope the restaurant's licence client already understands.
 *
 * Getting the translation key wrong here does not break activation; it quietly
 * shows an English sentence to an Arabic restaurant, which is why the old
 * mismatch survived as long as it did.
 */
const fail = (status: number, code: string, detail: string, details: unknown = {}) =>
  json(status, {
    error: {
      code,
      // `LICENSE_REVOKED` → `license.error.revoked`; a generic code such as
      // `NOT_FOUND` → `error.not_found`, which the application already has a
      // sentence for in every language it ships.
      messageKey: code.startsWith('LICENSE_')
        ? `license.error.${code.slice('LICENSE_'.length).toLowerCase()}`
        : `error.${code.toLowerCase()}`,
      message: detail,
      details,
    },
  });

/* ---------------------------------------------------------- rate limit */

/**
 * Activation is the one unauthenticated write in the system, so it is capped
 * per source address. The counter lives in this instance's memory and is lost
 * when the instance is recycled, which is the right trade here: the key's
 * checksum already makes guessing hopeless, and this exists to blunt a client
 * stuck in a retry loop rather than to stop a determined attacker.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const seen = new Map<string, { count: number; until: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = seen.get(ip);
  if (!entry || entry.until < now) {
    seen.set(ip, { count: 1, until: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

/* ------------------------------------------------------------ database */

async function rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${projectUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function selectRows(path: string): Promise<unknown[]> {
  const res = await fetch(`${projectUrl}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
  });
  const text = await res.text();
  // The status alone does not say whether this was a policy, a missing grant
  // or a typo in a column name, and those look identical from here.
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

/* -------------------------------------------------------------- routes */

interface Body { [key: string]: unknown }

function requireKey(body: Body): string | null {
  const raw = typeof body.licenseKey === 'string' ? body.licenseKey : '';
  return normaliseLicenseKey(raw);
}

function requireFingerprint(body: Body): string | null {
  const value = typeof body.deviceFingerprint === 'string' ? body.deviceFingerprint : '';
  return DEVICE_FINGERPRINT_PATTERN.test(value) ? value : null;
}

async function activate(body: Body, ip: string): Promise<Response> {
  if (!SIGNING_PRIVATE || !SIGNING_PUBLIC) {
    return fail(503, 'INTERNAL', 'the licence server has no signing key configured');
  }
  const key = requireKey(body);
  if (!key) {
    return fail(400, 'LICENSE_INVALID_KEY_FORMAT',
      'license key is malformed or its checksum does not match');
  }
  const fingerprint = requireFingerprint(body);
  if (!fingerprint) {
    return fail(400, 'VALIDATION', 'deviceFingerprint must be 64 hex characters');
  }
  const appVersion = typeof body.appVersion === 'string' ? body.appVersion : '';
  if (!appVersion) return fail(400, 'VALIDATION', 'appVersion is required');

  const decided = await rpc('activate_license', {
    p_key_hash: await hashToken(key),
    p_fingerprint: fingerprint,
    p_label: typeof body.deviceLabel === 'string' ? body.deviceLabel : '',
    p_app_version: appVersion,
    p_restaurant_id: typeof body.restaurantId === 'string' ? body.restaurantId : null,
    p_client_ip: ip,
  });

  if (decided.error) {
    return fail(Number(decided.status ?? 400), String(decided.error), String(decided.detail ?? ''));
  }

  const certificate = await issueCertificate({
    v: ACTIVATION_CERTIFICATE_VERSION,
    licenseId: decided.licenseId,
    licenseType: decided.licenseType,
    restaurantId: decided.restaurantId,
    restaurantName: decided.restaurantName,
    deviceFingerprint: fingerprint,
    activationId: decided.activationId,
    issuedAt: new Date().toISOString(),
    transferCount: decided.transferCount,
    appVersion,
    // Perpetual: the certificate never stops being valid.
    notAfter: null,
    features: LICENSED_CAPABILITIES,
  }, SIGNING_PRIVATE, SIGNING_PUBLIC);

  return json(200, {
    certificate,
    nonce: typeof body.nonce === 'string' ? body.nonce : '',
    restaurantId: decided.restaurantId,
    licenseId: decided.licenseId,
  });
}

async function deactivate(body: Body, ip: string): Promise<Response> {
  const key = requireKey(body);
  if (!key) {
    return fail(400, 'LICENSE_INVALID_KEY_FORMAT',
      'license key is malformed or its checksum does not match');
  }
  const fingerprint = requireFingerprint(body);
  if (!fingerprint) {
    return fail(400, 'VALIDATION', 'deviceFingerprint must be 64 hex characters');
  }

  const decided = await rpc('deactivate_license', {
    p_key_hash: await hashToken(key),
    p_fingerprint: fingerprint,
    p_reason: typeof body.reason === 'string' ? body.reason : 'moving to another device',
    p_client_ip: ip,
  });

  if (decided.error) {
    return fail(Number(decided.status ?? 400), String(decided.error), String(decided.detail ?? ''));
  }
  return json(200, {
    licenseId: decided.licenseId,
    status: decided.status,
    nonce: typeof body.nonce === 'string' ? body.nonce : '',
  });
}

async function status(body: Body): Promise<Response> {
  const key = requireKey(body);
  if (!key) {
    return fail(400, 'LICENSE_INVALID_KEY_FORMAT',
      'license key is malformed or its checksum does not match');
  }
  const result = await rpc('license_status', { p_key_hash: await hashToken(key) });
  if (result.error) {
    return fail(Number(result.status ?? 400), String(result.error), String(result.detail ?? ''));
  }
  return json(200, result);
}

async function publicKeys(): Promise<Response> {
  const rows = await selectRows('signing_keys?select=key_id,public_key&active=is.true') as
    { key_id: string; public_key: string }[];
  return json(200, { keys: rows.map((r) => ({ keyId: r.key_id, publicKey: r.public_key })) });
}

/**
 * Who to contact for a licence, and what it costs.
 *
 * Public and unauthenticated because a restaurant in SETUP mode has no licence
 * yet — which is precisely when it needs to know who to call. Nothing here
 * identifies a restaurant, so there is nothing to leak.
 */
async function vendorInfo(): Promise<Response> {
  const rows = await selectRows(
    "vendor_settings?select=value_json&key=eq.vendor_info",
  ) as { value_json: unknown }[];
  return json(200, rows[0]?.value_json ?? {
    vendorName: '', contact: {}, pricing: {}, terms: '', updatedAt: null,
  });
}

/* ------------------------------------------------------------- serving */

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return json(204, {});

  const url = new URL(request.url);
  if (!projectUrl) projectUrl = url.origin;
  /*
   * What is left after the function's own name is the path the restaurant's
   * client built — `/v1/activate` and so on.
   *
   * Both prefixes are stripped because the platform has already removed
   * `/functions/v1` by the time this runs, leaving `/api/v1/activate`, while a
   * request that arrives through a proxy or a local `supabase functions serve`
   * still carries the whole thing. Assuming one shape gave a live function that
   * answered every route with "no route".
   */
  const path = url.pathname
    .replace(/^\/functions\/v1/, '')
    .replace(/^\/api/, '')
    .replace(/\/+$/, '') || '/';
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  try {
    if (request.method === 'GET' && path === '/v1/public-keys') return await publicKeys();

    if (rateLimited(ip)) {
      return fail(429, 'RATE_LIMITED', 'too many licence requests from this address',
        { retryAfterSeconds: 600 });
    }

    if (request.method === 'GET' && path === '/v1/vendor-info') return await vendorInfo();

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as Body;
      if (path === '/v1/activate') return await activate(body, ip);
      if (path === '/v1/deactivate') return await deactivate(body, ip);
      if (path === '/v1/status') return await status(body);
    }

    return fail(404, 'NOT_FOUND', `no route for ${request.method} ${path}`);
  } catch (error) {
    /*
     * The reason goes to the function's log, not to the caller.
     *
     * What went wrong here is a database grant, a missing column or an
     * unreachable PostgREST — vendor infrastructure, described in the vendor's
     * own vocabulary. A restaurant owner can do nothing with any of it, and a
     * stranger probing this endpoint should learn nothing from it.
     */
    console.error('[license]', error);
    return fail(500, 'INTERNAL', 'the licence server could not complete this request');
  }
});
