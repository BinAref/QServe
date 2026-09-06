/**
 * Developer/vendor console authentication (spec §29).
 *
 * The console can revoke a paying restaurant's licence, so it is protected by a
 * real password (scrypt-hashed), server-side sessions stored as hashes, and a
 * rate limiter on the login route. There is no "developer mode" back door and
 * no hard-coded credential anywhere in this repository.
 */

import { hashSecret, hashToken, newToken, verifySecret } from '@qserve/crypto';
import { AppError, ErrorCode, unauthenticated } from '@qserve/shared';
import {
  expiredCookie, parseCookies, RateLimiter, serialiseCookie,
  type Middleware, type RequestContext,
} from '@qserve/http';
import type { AdminUserRow, LicenseStore } from './store.js';

export const SESSION_COOKIE = 'qserve_ls_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AdminState extends Record<string, unknown> {
  admin?: AdminUserRow;
}

export const loginLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

/** Pre-computed so a login for an unknown username costs the same as a real one. */
const DUMMY_PASSWORD_HASH = hashSecret('no-such-user-placeholder');

export class AdminAuth {
  constructor(private readonly store: LicenseStore) {}

  /**
   * Create the first developer account if the database has none. The password
   * comes from the environment, or is generated and printed once — never
   * defaulted to something guessable.
   */
  ensureBootstrapAdmin(username: string | null, password: string | null): {
    created: boolean; username: string; generatedPassword: string | null;
  } {
    if (this.store.countAdmins() > 0) {
      return { created: false, username: username ?? '', generatedPassword: null };
    }
    const name = username?.trim() || 'developer';
    const generated = password ? null : newToken(12);
    const secret = password ?? generated!;

    this.store.createAdmin({
      username: name,
      passwordHash: hashSecret(secret),
      displayName: 'Vendor developer',
    });
    this.store.audit({ actor: 'system', action: 'admin.bootstrap', detail: { username: name } });

    return { created: true, username: name, generatedPassword: generated };
  }

  login(username: string, password: string, ip: string): { token: string; admin: AdminUserRow } {
    const verdict = loginLimiter.check(`${ip}:${username}`);
    if (!verdict.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, 'too many sign-in attempts', {
        status: 429,
        messageKey: 'error.rate_limited',
        details: { retryAfterSeconds: verdict.retryAfterSeconds },
      });
    }

    const admin = this.store.getAdminByUsername(username);
    // Always run the verification, even for an unknown user, so that a wrong
    // username and a wrong password are indistinguishable by timing.
    const ok = verifySecret(password, admin?.password_hash ?? DUMMY_PASSWORD_HASH);

    if (!admin || admin.active !== 1 || !ok) {
      throw unauthenticated('invalid credentials');
    }

    loginLimiter.reset(`${ip}:${username}`);

    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.store.createSession(hashToken(token), admin.id, expiresAt, ip);
    this.store.touchAdminLogin(admin.id);
    this.store.audit({ actor: admin.username, action: 'admin.login', detail: {}, clientIp: ip });

    return { token, admin };
  }

  logout(token: string | undefined): void {
    if (token) this.store.deleteSession(hashToken(token));
  }

  resolve(ctx: RequestContext<AdminState>): AdminUserRow | null {
    const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;

    const session = this.store.getSession(hashToken(token));
    if (!session) return null;

    if (new Date(session.expires_at).getTime() < Date.now()) {
      this.store.deleteSession(hashToken(token));
      return null;
    }
    const admin = this.store.getAdminById(session.admin_id);
    return admin && admin.active === 1 ? admin : null;
  }

  /** Middleware guarding every console API route. */
  require(): Middleware<AdminState> {
    return (ctx, next) => {
      const admin = this.resolve(ctx);
      if (!admin) throw unauthenticated('developer sign-in required');
      ctx.state.admin = admin;
      return next();
    };
  }
}

export const sessionCookie = (token: string): string =>
  serialiseCookie(SESSION_COOKIE, token, {
    maxAgeSeconds: SESSION_TTL_MS / 1000,
    sameSite: 'Strict',
    httpOnly: true,
    // The vendor is expected to terminate TLS in front of this server; the flag
    // is honoured when QSERVE_LS_SECURE_COOKIES is set.
    secure: process.env.QSERVE_LS_SECURE_COOKIES === 'true',
  });

export const clearSessionCookie = (): string => expiredCookie(SESSION_COOKIE);
