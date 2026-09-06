/**
 * In-memory sliding-window rate limiter.
 *
 * Applied to the operations where guessing pays: staff PIN login, terminal
 * enrolment and licence activation. In-memory is the right scope — each
 * installation is a single process on a single PC, and a restart clearing the
 * counters is not a meaningful weakness for a LAN-local attacker.
 */

export interface RateLimitOptions {
  readonly windowMs: number;
  readonly max: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly options: RateLimitOptions) {}

  check(key: string, now: number = Date.now()): RateLimitVerdict {
    const since = now - this.options.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > since);

    if (timestamps.length >= this.options.max) {
      const oldest = timestamps[0]!;
      this.hits.set(key, timestamps);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.options.windowMs - now) / 1000)),
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return {
      allowed: true,
      remaining: this.options.max - timestamps.length,
      retryAfterSeconds: 0,
    };
  }

  /** Called after a success so a legitimate user is not punished for one typo. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Drop windows that can no longer deny anything. Called periodically. */
  prune(now: number = Date.now()): void {
    const since = now - this.options.windowMs;
    for (const [key, timestamps] of this.hits) {
      const live = timestamps.filter((t) => t > since);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }
}
