/**
 * Authentication, actor resolution and authorisation (spec §15, §23).
 *
 * Every request carries two independent identities, and the system needs both:
 *
 *   the **terminal** — which station this is (Kitchen 01, Cashier 02, Table 05)
 *   the **user**     — which human is acting (Cashier Sara)
 *
 * A terminal alone is enough to run a kitchen screen. It is deliberately *not*
 * enough to take money: `requireUser` guards payment routes so a receipt can
 * always name the person who captured it, as the spec insists.
 *
 * The effective permission set is the intersection of the terminal's ceiling
 * and the user's role grants. Scanning a kitchen QR on a manager's phone
 * therefore yields kitchen powers, not manager powers.
 */

import {
  ActorKind, forbidden, grants, intersectPermissions, pickLocalised, TERMINAL_TYPE_CEILING,
  unauthenticated, WILDCARD_PERMISSION, type Actor, type Capability,
} from '@qserve/shared';
import { parseCookies, serialiseCookie, expiredCookie, type Middleware, type RequestContext } from '@qserve/http';
import type { AccessRepository, UserRow } from './repositories/access.js';
import type { TerminalRepository, TerminalRow } from './repositories/terminals.js';
import type { LicenseGate } from './license-gate.js';

export const TERMINAL_COOKIE = 'qs_terminal';
export const USER_COOKIE = 'qs_user';

export interface AuthContext {
  readonly actor: Actor;
  readonly permissions: readonly string[];
  readonly terminal: TerminalRow | null;
  readonly user: UserRow | null;
}

export interface AppState extends Record<string, unknown> {
  auth?: AuthContext;
}

export type AppContext = RequestContext<AppState>;

const ANONYMOUS: Actor = {
  kind: ActorKind.SYSTEM,
  userId: null,
  userName: null,
  terminalId: null,
  terminalName: null,
};

export class SecurityService {
  constructor(
    private readonly access: AccessRepository,
    private readonly terminals: TerminalRepository,
    private readonly gate: LicenseGate,
    private readonly defaultLocale: () => string,
  ) {}

  /* -------------------------------------------------------- resolution */

  private resolveTerminal(cookies: Record<string, string>): TerminalRow | null {
    const token = cookies[TERMINAL_COOKIE];
    if (!token) return null;

    const session = this.terminals.getSession(token);
    if (!session) return null;
    if (new Date(session.expires_at).getTime() < Date.now()) {
      this.terminals.deleteSession(token);
      return null;
    }
    const terminal = this.terminals.get(session.terminal_id);
    if (!terminal || terminal.status !== 'ACTIVE') return null;

    this.terminals.touchSeen(terminal.id);
    return terminal;
  }

  private resolveUser(cookies: Record<string, string>): UserRow | null {
    const token = cookies[USER_COOKIE];
    if (!token) return null;

    const session = this.access.getUserSession(token);
    if (!session) return null;
    if (new Date(session.expires_at).getTime() < Date.now()) {
      this.access.deleteUserSession(token);
      return null;
    }
    const user = this.access.getUser(session.user_id);
    return user && user.active === 1 ? user : null;
  }

  /** Permissions a terminal may exercise: its type ceiling plus explicit extras. */
  terminalPermissions(terminal: TerminalRow): string[] {
    const ceiling = TERMINAL_TYPE_CEILING[terminal.terminal_type] ?? [];
    const extras = this.terminals.permissions(terminal);
    if (ceiling.includes(WILDCARD_PERMISSION)) return [WILDCARD_PERMISSION];
    return [...new Set([...ceiling, ...extras])];
  }

  resolve(ctx: AppContext): AuthContext {
    return this.resolveFromCookieHeader(ctx.req.headers.cookie);
  }

  /**
   * Cookie-header form, so the WebSocket upgrade can authorise a socket with
   * exactly the same rules as an HTTP request rather than a parallel path.
   */
  resolveFromCookieHeader(cookieHeader: string | undefined): AuthContext {
    const cookies = parseCookies(cookieHeader);
    const terminal = this.resolveTerminal(cookies);
    const user = this.resolveUser(cookies);
    const locale = this.defaultLocale();

    const terminalName = terminal
      ? pickLocalised(this.terminals.name(terminal), locale) || terminal.id
      : null;

    if (!terminal && !user) {
      return { actor: ANONYMOUS, permissions: [], terminal: null, user: null };
    }

    const userPermissions = user ? this.access.permissionsForUser(user.id) : null;
    const terminalGrants = terminal ? this.terminalPermissions(terminal) : null;

    let permissions: string[];
    if (userPermissions && terminalGrants) {
      // Both present: the narrower of the two wins, always.
      permissions = intersectPermissions(terminalGrants, userPermissions);
    } else if (userPermissions) {
      permissions = userPermissions;
    } else {
      permissions = terminalGrants ?? [];
    }

    const kind = user
      ? ActorKind.USER
      : terminal?.terminal_type === 'TABLE'
        ? ActorKind.CUSTOMER
        : ActorKind.TERMINAL;

    return {
      actor: {
        kind,
        userId: user?.id ?? null,
        userName: user?.display_name ?? null,
        terminalId: terminal?.id ?? null,
        terminalName,
      },
      permissions,
      terminal,
      user,
    };
  }

  /* ------------------------------------------------------- middleware */

  /** Populates `ctx.state.auth` for every request. Never refuses. */
  authenticate(): Middleware<AppState> {
    return (ctx, next) => {
      ctx.state.auth = this.resolve(ctx);
      return next();
    };
  }

  requirePermission(permission: string): Middleware<AppState> {
    return (ctx, next) => {
      const auth = ctx.state.auth ?? this.resolve(ctx);
      ctx.state.auth = auth;

      if (auth.actor.kind === ActorKind.SYSTEM && auth.permissions.length === 0) {
        throw unauthenticated('sign in on a terminal or as a user');
      }
      if (!grants(auth.permissions, permission)) throw forbidden(permission);
      return next();
    };
  }

  /**
   * Demands an identified human. Used wherever the audit trail must name a
   * person rather than a station: payments, refunds, voids, settings.
   */
  requireUser(permission?: string): Middleware<AppState> {
    return (ctx, next) => {
      const auth = ctx.state.auth ?? this.resolve(ctx);
      ctx.state.auth = auth;

      if (!auth.user) throw unauthenticated('this action must be signed for by a user');
      if (permission && !grants(auth.permissions, permission)) throw forbidden(permission);
      return next();
    };
  }

  /** Refuses anything the current licence state does not unlock. */
  requireCapability(capability: Capability): Middleware<AppState> {
    return (ctx, next) => {
      this.gate.assert(capability);
      return next();
    };
  }

  /**
   * Management operations are reachable only from the loopback console, never
   * from the restaurant Wi-Fi — defence in depth behind the permission check.
   */
  adminListenerOnly(): Middleware<AppState> {
    return (ctx, next) => {
      if (ctx.listener !== 'admin') {
        throw forbidden('this operation is available only on the management console');
      }
      return next();
    };
  }
}

/* ------------------------------------------------------------- cookies */

export const terminalCookie = (token: string, ttlSeconds: number): string =>
  serialiseCookie(TERMINAL_COOKIE, token, {
    maxAgeSeconds: ttlSeconds,
    sameSite: 'Lax',
    httpOnly: true,
  });

export const userCookie = (token: string, ttlSeconds: number): string =>
  serialiseCookie(USER_COOKIE, token, {
    maxAgeSeconds: ttlSeconds,
    sameSite: 'Lax',
    httpOnly: true,
  });

export const clearTerminalCookie = (): string => expiredCookie(TERMINAL_COOKIE);
export const clearUserCookie = (): string => expiredCookie(USER_COOKIE);

export const readTerminalToken = (ctx: AppContext): string | undefined =>
  parseCookies(ctx.req.headers.cookie)[TERMINAL_COOKIE];

export const readUserToken = (ctx: AppContext): string | undefined =>
  parseCookies(ctx.req.headers.cookie)[USER_COOKIE];

/** Convenience for handlers: the resolved auth, or a 401. */
export function requireAuth(ctx: AppContext): AuthContext {
  const auth = ctx.state.auth;
  if (!auth) throw unauthenticated();
  return auth;
}
