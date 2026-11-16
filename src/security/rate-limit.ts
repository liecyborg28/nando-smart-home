/**
 * Fixed-window in-memory rate limiter.
 * Scope: one server instance. A multi-instance deployment needs a shared store
 * (e.g. Redis) behind the same interface; this is documented as a known limit.
 */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private static readonly MAX_KEYS = 10_000;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Counts `cost` units for `key` and reports whether the window's budget still holds.
   * A cost above 1 lets expensive operations (many provider calls) weigh more than cheap ones.
   */
  hit(key: string, cost = 1): RateLimitResult {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.prune(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count += cost;
    const retryAfterSeconds = Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    return { allowed: w.count <= this.limit, retryAfterSeconds };
  }

  private prune(t: number): void {
    if (this.windows.size < FixedWindowRateLimiter.MAX_KEYS) return;
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

/** Caps simultaneous in-flight requests per key, so one client cannot occupy every worker. */
export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Returns a release function, or undefined when the key is already at its limit. */
  acquire(key: string): (() => void) | undefined {
    const n = this.active.get(key) ?? 0;
    if (n >= this.max) return undefined;
    this.active.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(key) ?? 1) - 1;
      if (left <= 0) this.active.delete(key);
      else this.active.set(key, left);
    };
  }
}
