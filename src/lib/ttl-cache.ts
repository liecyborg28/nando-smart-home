/**
 * Small TTL cache with in-flight de-duplication. Rejected loads are never cached,
 * and concurrent callers for the same key share ONE load.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 500,
  ) {}

  /** `fresh` skips any cached value (and any load already in flight) but still stores the result. */
  async get(key: string, load: () => Promise<V>, options: { fresh?: boolean } = {}): Promise<V> {
    const t = this.now();
    if (!options.fresh) {
      const hit = this.entries.get(key);
      if (hit && hit.expires > t) return hit.value;
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }
    const promise = load().then(
      (value) => {
        this.store(key, value);
        return value;
      },
      (error: unknown) => {
        throw error;
      },
    );
    const tracked = promise.finally(() => {
      if (this.inflight.get(key) === tracked) this.inflight.delete(key);
    });
    this.inflight.set(key, tracked);
    return tracked;
  }

  delete(key: string): void {
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  private store(key: string, value: V): void {
    if (this.ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const t = this.now();
      for (const [k, e] of this.entries) if (e.expires <= t) this.entries.delete(k);
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    }
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
  }
}
