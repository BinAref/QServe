/**
 * Optional app lock for the management console.
 *
 * A restaurant PC often sits in a back room where deliveries arrive and staff
 * come and go. An owner may want the console to open on a password screen; an
 * owner running the machine in a locked office may not. It is their choice, and
 * it is off until they turn it on.
 *
 * Two properties matter:
 *
 *  - **It is a real lock, not a hidden screen.** While locked, the middleware
 *    refuses every console route except the handful needed to unlock. Reading
 *    the menu, the orders or the takings over the API is impossible.
 *  - **It never locks the restaurant out of service.** The lock guards the
 *    *console* only. Tables, kitchen, till and waiter terminals on the LAN keep
 *    working, because a forgotten office password must not stop dinner.
 */

import { hashSecret, hashToken, newToken, verifySecret } from '@qserve/crypto';
import {
  AppError, ErrorCode, conflict, unauthenticated, validationError, type Actor,
} from '@qserve/shared';
import {
  expiredCookie, parseCookies, RateLimiter, serialiseCookie, type Middleware,
} from '@qserve/http';
import type { AuditRepository } from './repositories/audit.js';
import type { SettingsRepository } from './repositories/settings.js';
import type { AppState } from './security.js';

export const LOCK_COOKIE = 'qs_unlocked';

/** Guessing a lock passphrase should be as slow as guessing a staff PIN. */
const unlockLimiter = new RateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });

interface UnlockSession {
  /** Wall-clock deadline; refreshed on activity while the console is in use. */
  expiresAt: number;
}

export interface LockStatus {
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly hint: string | null;
  readonly idleMinutes: number;
}

export class AppLockService {
  /**
   * Live unlock sessions, held in memory rather than the database on purpose:
   * restarting the application re-locks it, which is the behaviour an owner
   * expects from a lock.
   */
  private readonly sessions = new Map<string, UnlockSession>();

  constructor(
    private readonly settings: SettingsRepository,
    private readonly audit: AuditRepository,
  ) {}

  get enabled(): boolean {
    return this.settings.get<boolean>('security.appLockEnabled') === true
      && typeof this.settings.get<string | null>('security.appLockHash') === 'string';
  }

  private idleMs(): number {
    const minutes = this.settings.get<number>('security.appLockIdleMinutes');
    return Math.max(1, Number.isFinite(minutes) ? minutes : 30) * 60 * 1000;
  }

  /** Is this request holding a live unlock session? */
  isUnlocked(cookieHeader: string | undefined, { touch = true } = {}): boolean {
    if (!this.enabled) return true;

    const token = parseCookies(cookieHeader)[LOCK_COOKIE];
    if (!token) return false;

    const key = hashToken(token);
    const session = this.sessions.get(key);
    if (!session) return false;

    if (session.expiresAt < Date.now()) {
      this.sessions.delete(key);
      return false;
    }
    // Sliding expiry: the console re-locks after a period of *inactivity*, not
    // a fixed time, so a long shift does not interrupt someone mid-task.
    if (touch) session.expiresAt = Date.now() + this.idleMs();
    return true;
  }

  status(cookieHeader: string | undefined): LockStatus {
    return {
      enabled: this.enabled,
      locked: this.enabled && !this.isUnlocked(cookieHeader, { touch: false }),
      hint: this.settings.get<string | null>('security.appLockHint'),
      idleMinutes: this.settings.get<number>('security.appLockIdleMinutes'),
    };
  }

  unlock(passphrase: string, ip: string): string {
    if (!this.enabled) throw conflict('the app lock is not enabled');

    const verdict = unlockLimiter.check(ip);
    if (!verdict.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, 'too many unlock attempts', {
        status: 429,
        messageKey: 'error.rate_limited',
        details: { retryAfterSeconds: verdict.retryAfterSeconds },
      });
    }

    const stored = this.settings.get<string | null>('security.appLockHash');
    if (!stored || !verifySecret(passphrase, stored)) {
      this.audit.record({
        action: 'applock.failed',
        actor: systemActor(),
        entityType: 'app_lock',
        clientIp: ip,
      });
      throw unauthenticated('incorrect passphrase');
    }

    unlockLimiter.reset(ip);

    const token = newToken();
    this.sessions.set(hashToken(token), { expiresAt: Date.now() + this.idleMs() });
    this.audit.record({
      action: 'applock.unlocked',
      actor: systemActor(),
      entityType: 'app_lock',
      clientIp: ip,
    });
    return token;
  }

  /** Lock immediately — the "lock now" button, and used when the lock is set. */
  lockAll(actor: Actor, ip: string | null): void {
    this.sessions.clear();
    this.audit.record({
      action: 'applock.locked',
      actor,
      entityType: 'app_lock',
      clientIp: ip,
    });
  }

  /**
   * Turn the lock on, off, or change its passphrase. Enabling requires the new
   * passphrase; disabling requires the current one, so someone who wandered up
   * to an unlocked console cannot quietly switch the lock off.
   */
  configure(input: {
    enabled: boolean;
    passphrase?: string | null;
    currentPassphrase?: string | null;
    hint?: string | null;
    idleMinutes?: number;
    actor: Actor;
    clientIp: string | null;
  }): LockStatus {
    const wasEnabled = this.enabled;
    const stored = this.settings.get<string | null>('security.appLockHash');

    if (wasEnabled) {
      const supplied = input.currentPassphrase ?? '';
      if (!stored || !verifySecret(supplied, stored)) {
        throw unauthenticated('the current passphrase is required to change the lock');
      }
    }

    if (input.enabled) {
      const passphrase = input.passphrase ?? '';
      // A new passphrase is required to enable, and to change one; keeping the
      // existing one is expressed by leaving it blank while already enabled.
      if (!wasEnabled || passphrase !== '') {
        if (passphrase.length < 4) {
          throw validationError('the lock passphrase must be at least 4 characters', {
            field: 'passphrase',
          });
        }
        this.settings.set('security.appLockHash', hashSecret(passphrase));
      }
      this.settings.set('security.appLockEnabled', true);
    } else {
      this.settings.set('security.appLockEnabled', false);
      this.settings.set('security.appLockHash', null);
    }

    if (input.hint !== undefined) this.settings.set('security.appLockHint', input.hint);
    if (input.idleMinutes !== undefined) {
      this.settings.set(
        'security.appLockIdleMinutes',
        Math.min(Math.max(Math.round(input.idleMinutes), 1), 24 * 60),
      );
    }

    // Any change to the lock invalidates every open unlock session.
    this.sessions.clear();

    this.audit.record({
      action: input.enabled ? 'applock.enabled' : 'applock.disabled',
      actor: input.actor,
      entityType: 'app_lock',
      before: { enabled: wasEnabled },
      after: { enabled: input.enabled },
      clientIp: input.clientIp,
    });

    return this.status(undefined);
  }

  /**
   * Refuse everything on the console while locked, apart from the routes needed
   * to draw the lock screen and to unlock it.
   *
   * `allowed` holds exact paths, or prefixes written with a trailing `*`.
   */
  guard(allowed: readonly string[]): Middleware<AppState> {
    const exact = new Set(allowed.filter((entry) => !entry.endsWith('*')));
    const prefixes = allowed
      .filter((entry) => entry.endsWith('*'))
      .map((entry) => entry.slice(0, -1));

    return (ctx, next) => {
      // The lock is a console feature. Staff terminals on the LAN are never
      // affected, because a forgotten office password must not stop service.
      if (ctx.listener !== 'admin') return next();
      if (exact.has(ctx.path)) return next();
      if (prefixes.some((prefix) => ctx.path.startsWith(prefix))) return next();
      if (this.isUnlocked(ctx.req.headers.cookie)) return next();

      throw new AppError(ErrorCode.APP_LOCKED, 'the console is locked', {
        status: 423,
        messageKey: 'lock.locked',
      });
    };
  }

  /** Drop expired sessions. Called on the same sweep as expired logins. */
  prune(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(key);
    }
    unlockLimiter.prune(now);
  }
}

function systemActor(): Actor {
  return {
    kind: 'SYSTEM', userId: null, userName: null, terminalId: null, terminalName: null,
  };
}

export const unlockCookie = (token: string, idleMinutes: number): string =>
  serialiseCookie(LOCK_COOKIE, token, {
    maxAgeSeconds: Math.max(60, idleMinutes * 60),
    sameSite: 'Strict',
    httpOnly: true,
  });

export const clearUnlockCookie = (): string => expiredCookie(LOCK_COOKIE);
