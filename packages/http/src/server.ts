/**
 * node:http adapter: turns a `Router` into a listening server.
 *
 * Owns the parts of the request lifecycle every route depends on — body
 * parsing with a hard size cap, security headers, and the single place where a
 * thrown `AppError` becomes an HTTP status and a translation key.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AppError, ErrorCode } from '@qserve/shared';
import { Router, runChain } from './router.js';
import { HttpResponse, type HttpMethod, type RequestContext } from './types.js';

export interface ServerOptions<S> {
  readonly router: Router<S>;
  readonly listener: 'admin' | 'lan';
  /** Reject bodies above this size. Menu images travel as separate uploads. */
  readonly maxBodyBytes?: number;
  readonly createState: () => S;
  readonly onError?: (error: unknown, ctx: RequestContext<S> | null) => void;
  /**
   * Cross-origin is not used by the product — every front-end is served by this
   * same origin — so CORS stays off unless an integration explicitly needs it.
   */
  readonly allowedOrigins?: readonly string[];
}

const DEFAULT_MAX_BODY = 2 * 1024 * 1024;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
  // No external origins: the product must work with the internet unplugged, so
  // a page that tries to reach the network is a bug worth failing loudly.
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; " +
    "font-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
};

export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) {
      throw new AppError(ErrorCode.VALIDATION, 'request body too large', {
        status: 413,
        messageKey: 'error.body_too_large',
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseBody(raw: Buffer, contentType: string | undefined): unknown {
  if (raw.length === 0) return undefined;
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase();

  if (type === 'application/json' || type === undefined || type === '') {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError(ErrorCode.VALIDATION, 'request body is not valid JSON', {
        messageKey: 'error.invalid_json',
      });
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  }
  // Binary uploads (logos, backup restores) are handed to the route untouched.
  return raw;
}

function send(res: ServerResponse, response: HttpResponse): void {
  const headers: Record<string, string> = { ...SECURITY_HEADERS, ...response.headers };
  if (response.body !== null && headers['content-length'] === undefined) {
    headers['content-length'] = String(Buffer.byteLength(response.body));
  }
  res.writeHead(response.status, headers);
  res.end(response.body ?? undefined);
}

function toResponse(result: unknown): HttpResponse {
  if (result instanceof HttpResponse) return result;
  if (result === undefined) return HttpResponse.noContent();
  return HttpResponse.json(200, result);
}

function errorToResponse(error: unknown): HttpResponse {
  if (error instanceof AppError) {
    return HttpResponse.json(error.status, error.toJSON());
  }
  return HttpResponse.json(500, {
    error: { code: ErrorCode.INTERNAL, messageKey: 'error.internal', details: {} },
  });
}

export function createHttpServer<S>(options: ServerOptions<S>): Server {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return createServer((req, res) => {
    void handle(req, res, options, maxBody);
  });
}

async function handle<S>(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions<S>,
  maxBody: number,
): Promise<void> {
  let ctx: RequestContext<S> | null = null;
  try {
    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;
    const url = new URL(req.url ?? '/', 'http://local.invalid');
    const path = url.pathname;

    if (method === 'OPTIONS') {
      const allowed = options.router.allowedMethods(path);
      send(res, new HttpResponse(204, null, {
        allow: [...allowed, 'OPTIONS'].join(', '),
      }));
      return;
    }

    // HEAD is answered by the GET route; the adapter suppresses the body.
    const routeMethod = method === 'HEAD' ? 'GET' : method;
    const match = options.router.resolve(routeMethod, path);

    if (!match) {
      const allowed = options.router.allowedMethods(path);
      if (allowed.length > 0) {
        send(res, HttpResponse.json(405, {
          error: { code: 'METHOD_NOT_ALLOWED', messageKey: 'error.method_not_allowed', details: {} },
        }));
        return;
      }
      send(res, HttpResponse.json(404, {
        error: { code: ErrorCode.NOT_FOUND, messageKey: 'error.not_found', details: {} },
      }));
      return;
    }

    const hasBody = routeMethod !== 'GET' && routeMethod !== 'DELETE';
    const raw = hasBody ? await readBody(req, maxBody) : Buffer.alloc(0);

    ctx = {
      req,
      res,
      method,
      path,
      query: url.searchParams,
      params: match.params,
      body: hasBody ? parseBody(raw, req.headers['content-type']) : undefined,
      ip: clientIp(req),
      listener: options.listener,
      state: options.createState(),
    };

    const result = await runChain(ctx, match.middleware, match.handler);
    if (res.writableEnded || res.headersSent) return;

    const response = toResponse(result);
    if (method === 'HEAD') {
      send(res, new HttpResponse(response.status, null, response.headers));
      return;
    }
    send(res, response);
  } catch (error) {
    options.onError?.(error, ctx);
    if (!res.headersSent && !res.writableEnded) send(res, errorToResponse(error));
    else res.end();
  }
}
