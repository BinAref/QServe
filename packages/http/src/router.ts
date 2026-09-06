/**
 * A small pattern router.
 *
 * Deliberately not a framework: the whole product needs path parameters, a
 * middleware chain and typed errors, and nothing else. Keeping it here means
 * the request lifecycle — including where the license gate and the permission
 * check run — is readable in one file.
 */

import type { Handler, HttpMethod, Middleware, RequestContext } from './types.js';

interface Route<S> {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly handler: Handler<S>;
  readonly middleware: readonly Middleware<S>[];
}

const PARAM_PREFIX = ':';
const WILDCARD = '*';

const splitPath = (path: string): string[] =>
  path.split('/').filter((segment) => segment.length > 0);

export class Router<S = Record<string, unknown>> {
  private readonly routes: Route<S>[] = [];
  private readonly globalMiddleware: Middleware<S>[] = [];

  /** Runs for every request handled by this router, in registration order. */
  use(middleware: Middleware<S>): this {
    this.globalMiddleware.push(middleware);
    return this;
  }

  add(
    method: HttpMethod,
    path: string,
    handler: Handler<S>,
    middleware: readonly Middleware<S>[] = [],
  ): this {
    this.routes.push({ method, segments: splitPath(path), handler, middleware });
    return this;
  }

  get(path: string, handler: Handler<S>, mw: readonly Middleware<S>[] = []): this {
    return this.add('GET', path, handler, mw);
  }
  post(path: string, handler: Handler<S>, mw: readonly Middleware<S>[] = []): this {
    return this.add('POST', path, handler, mw);
  }
  put(path: string, handler: Handler<S>, mw: readonly Middleware<S>[] = []): this {
    return this.add('PUT', path, handler, mw);
  }
  patch(path: string, handler: Handler<S>, mw: readonly Middleware<S>[] = []): this {
    return this.add('PATCH', path, handler, mw);
  }
  delete(path: string, handler: Handler<S>, mw: readonly Middleware<S>[] = []): this {
    return this.add('DELETE', path, handler, mw);
  }

  /** Mount another router under a prefix, preserving its own middleware. */
  mount(prefix: string, child: Router<S>): this {
    const prefixSegments = splitPath(prefix);
    for (const route of child.routes) {
      this.routes.push({
        ...route,
        segments: [...prefixSegments, ...route.segments],
        middleware: [...child.globalMiddleware, ...route.middleware],
      });
    }
    return this;
  }

  /** Methods allowed for a path, so 405 replies can advertise `Allow`. */
  allowedMethods(path: string): HttpMethod[] {
    const segments = splitPath(path);
    const methods = new Set<HttpMethod>();
    for (const route of this.routes) {
      if (matchSegments(route.segments, segments)) methods.add(route.method);
    }
    return [...methods];
  }

  /** Resolve a request to a handler chain, or null when no route matches. */
  resolve(
    method: HttpMethod,
    path: string,
  ): { handler: Handler<S>; params: Record<string, string>; middleware: Middleware<S>[] } | null {
    const segments = splitPath(path);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      return {
        handler: route.handler,
        params,
        middleware: [...this.globalMiddleware, ...route.middleware],
      };
    }
    return null;
  }
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const patternSegment = pattern[i]!;

    if (patternSegment === WILDCARD) {
      params['wildcard'] = actual.slice(i).join('/');
      return params;
    }
    const actualSegment = actual[i];
    if (actualSegment === undefined) return null;

    if (patternSegment.startsWith(PARAM_PREFIX)) {
      params[patternSegment.slice(1)] = decodeURIComponent(actualSegment);
      continue;
    }
    if (patternSegment !== actualSegment) return null;
  }
  return pattern.length === actual.length ? params : null;
}

/** Compose a middleware chain terminated by `handler`. */
export async function runChain<S>(
  ctx: RequestContext<S>,
  middleware: readonly Middleware<S>[],
  handler: Handler<S>,
): Promise<unknown> {
  let result: unknown;
  let index = -1;

  const dispatch = async (i: number): Promise<void> => {
    if (i <= index) throw new Error('next() called more than once in one middleware');
    index = i;
    const fn = middleware[i];
    if (!fn) {
      result = await handler(ctx);
      return;
    }

    let continued = false;
    const returned = await fn(ctx, () => {
      continued = true;
      return dispatch(i + 1);
    });

    // A middleware that returns a value *without* calling next() short-circuits
    // the chain — that is how the auth and license-gate middleware refuse a
    // request. Once next() has run, the handler's result is the answer.
    if (!continued && returned !== undefined) result = returned;
  };

  await dispatch(0);
  return result;
}
