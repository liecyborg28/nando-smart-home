import type { NewToken, TokenRecord, TokenStore, TokenSummary } from "./token-store";

/** Token store for tests and local experiments. Mirrors the Postgres store's behaviour. */
export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, TokenRecord>();
  /** Test hook: make every call fail, to prove authentication fails closed. */
  failing = false;
  /** Test hook: counts lookups so cache behaviour can be asserted. */
  lookups = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private guard(): void {
    if (this.failing) throw new Error("token store unavailable");
  }

  /** Synchronous insert for test setup. */
  seed(token: NewToken): void {
    this.tokens.set(token.id, {
      id: token.id,
      name: token.name,
      scopes: [...token.scopes],
      secretHash: Buffer.from(token.secretHash),
      createdAt: this.now(),
      createdBy: token.createdBy ?? null,
      expiresAt: token.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
      revokedReason: null,
    });
  }

  async create(token: NewToken): Promise<TokenSummary> {
    this.guard();
    if (this.tokens.has(token.id)) throw new Error("duplicate token id");
    const record: TokenRecord = {
      id: token.id,
      name: token.name,
      scopes: [...token.scopes],
      secretHash: Buffer.from(token.secretHash),
      createdAt: this.now(),
      createdBy: token.createdBy ?? null,
      expiresAt: token.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
      revokedReason: null,
    };
    this.tokens.set(record.id, record);
    return summary(record);
  }

  async findById(id: string): Promise<TokenRecord | undefined> {
    this.guard();
    this.lookups++;
    const r = this.tokens.get(id);
    return r ? { ...r, scopes: [...r.scopes], secretHash: Buffer.from(r.secretHash) } : undefined;
  }

  async list(): Promise<TokenSummary[]> {
    this.guard();
    return [...this.tokens.values()].map(summary).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async revoke(id: string, reason?: string): Promise<boolean> {
    this.guard();
    const r = this.tokens.get(id);
    if (!r || r.revokedAt) return false;
    r.revokedAt = this.now();
    r.revokedReason = reason ?? null;
    return true;
  }

  async revokeAll(reason?: string): Promise<number> {
    this.guard();
    let n = 0;
    for (const r of this.tokens.values()) {
      if (!r.revokedAt) {
        r.revokedAt = this.now();
        r.revokedReason = reason ?? null;
        n++;
      }
    }
    return n;
  }

  async touch(id: string, at: Date): Promise<void> {
    this.guard();
    const r = this.tokens.get(id);
    if (r) r.lastUsedAt = at;
  }
}

function summary(r: TokenRecord): TokenSummary {
  const { secretHash: _omit, ...rest } = r;
  void _omit;
  return { ...rest, scopes: [...rest.scopes] };
}
