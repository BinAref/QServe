/** Request/response primitives shared by the router, middleware and handlers. */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RequestContext<State = Record<string, unknown>> {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: HttpMethod;
  /** Path only, query stripped and percent-decoding left intact. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** Route parameters captured from the pattern, e.g. `/orders/:id`. */
  readonly params: Readonly<Record<string, string>>;
  /** Parsed JSON body, or undefined for bodyless methods. */
  readonly body: unknown;
  /** Best-effort client address; used for rate limiting and audit records. */
  readonly ip: string;
  /**
   * Which listener accepted this request. The LAN listener is exposed to the
   * restaurant's Wi-Fi; `admin` is loopback-only. Routes use this to refuse
   * management operations that must never be reachable from a diner's phone.
   */
  readonly listener: 'admin' | 'lan';
  /** Per-request scratch space populated by middleware (session, actor, …). */
  state: State;
}

/**
 * A handler either returns a value to be JSON-encoded, or returns a `Response`
 * describing a non-JSON reply, or writes to `ctx.res` itself and returns
 * `undefined`.
 */
export type Handler<S = Record<string, unknown>> = (
  ctx: RequestContext<S>,
) => unknown | Promise<unknown>;

export type Middleware<S = Record<string, unknown>> = (
  ctx: RequestContext<S>,
  next: () => Promise<void>,
) => unknown | Promise<unknown>;

/** Explicit reply, for when the default "200 + JSON" is not what is wanted. */
export class HttpResponse {
  constructor(
    readonly status: number,
    readonly body: string | Buffer | null,
    readonly headers: Record<string, string> = {},
  ) {}

  static json(status: number, value: unknown): HttpResponse {
    return new HttpResponse(status, JSON.stringify(value), {
      'content-type': 'application/json; charset=utf-8',
    });
  }

  static text(status: number, value: string, contentType = 'text/plain; charset=utf-8'): HttpResponse {
    return new HttpResponse(status, value, { 'content-type': contentType });
  }

  static noContent(): HttpResponse {
    return new HttpResponse(204, null);
  }

  static redirect(location: string, status = 302): HttpResponse {
    return new HttpResponse(status, null, { location });
  }
}
