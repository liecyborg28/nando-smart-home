import { createHash, timingSafeEqual } from "node:crypto";
import { hashSecret, parseToken, safeEqualHash, type TokenRecord, type TokenStore } from "./token-store";

/**
 * Token authentication.
 *
 *  - The bearer token `nsh_<id>.<secret>` is parsed strictly, looked up by id, and its
 *    secret hash compared in constant time. Unknown ids run a dummy comparison so the
 *    response time does not reveal whether an id exists.
 *  - Revoked/expired tokens are rejected. Records are cached in-process for a few seconds
 *    (config TOKEN_CACHE_TTL_SECONDS), so a revocation takes effect within that window.
 *  - If the token store is unreachable the result is `store_unavailable` and the caller
 *    MUST refuse the request: authentication never fails open.
 */

export const SCOPES = { read: "smarthome:read", write: "smarthome:write" } as const;
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export interface Principal {
  /** Token id. Used for rate limiting, confirmation binding and audit. */
  id: string;
  /** Human label chosen when the token was created (e.g. "agno-read"). */
  name: string;
  scopes: Scope[];
}

export type AuthFailure = "missing" | "malformed" | "unknown" | "invalid" | "revoked" | "expired";

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: AuthFailure }
  | { ok: false; reason: "store_unavailable"; cause: string };

/**
 * A short, safe description of why the store failed, for the operator's log: only the error's name and
 * code (e.g. "Error:ECONNRESET", "error:28P01"). Never the message, which can carry hosts or credentials.
 */
function safeCause(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const { name, code } = error as { name?: unknown; code?: unknown };
  const n = typeof name === "string" ? name.slice(0, 40) : "Error";
  const c = typeof code === "string" || typeof code === "number" ? String(code).slice(0, 40) : "";
  return c ? `${n}:${c}` : n;
}

export function extractBearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}

export interface AuthenticatorOptions {
  /** 0 disables the cache (every request checks the store). */
  cacheTtlMs: number;
  now?: () => number;
  /** Minimum gap between `last_used_at` writes for one token. */
  touchIntervalMs?: number;
}

const MAX_CACHE_ENTRIES = 1000;
// Compared against when a token id is unknown/malformed, to keep timing uniform.
const DUMMY_HASH = createHash("sha256").update("nando-smart-home/dummy").digest();

interface CacheEntry {
  record: TokenRecord | undefined;
  fetchedAt: number;
}

const toScopes = (scopes: TokenRecord["scopes"]): Scope[] => scopes.map((s) => (s === "write" ? SCOPES.write : SCOPES.read));

export class TokenAuthenticator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastTouch = new Map<string, number>();
  private readonly now: () => number;
  private readonly touchIntervalMs: number;

  constructor(
    private readonly store: TokenStore,
    private readonly options: AuthenticatorOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.touchIntervalMs = options.touchIntervalMs ?? 60_000;
  }

  async authenticate(request: Request): Promise<AuthResult> {
    const bearer = extractBearerToken(request);
    if (!bearer) return { ok: false, reason: "missing" };

    const parsed = parseToken(bearer);
    if (!parsed) {
      this.dummyCompare(bearer);
      return { ok: false, reason: "malformed" };
    }

    let record: TokenRecord | undefined;
    try {
      record = await this.lookup(parsed.id);
    } catch (error) {
      return { ok: false, reason: "store_unavailable", cause: safeCause(error) };
    }

    const presented = hashSecret(parsed.secret);
    if (!record) {
      this.dummyCompare(parsed.secret);
      return { ok: false, reason: "unknown" };
    }
    if (!safeEqualHash(presented, record.secretHash)) return { ok: false, reason: "invalid" };

    const t = this.now();
    // Revocation is never scheduled: any revoked_at means revoked. Comparing it with the app clock would
    // let a revoked token keep working whenever the database clock runs slightly ahead of this server.
    if (record.revokedAt) return { ok: false, reason: "revoked" };
    if (record.expiresAt && record.expiresAt.getTime() <= t) return { ok: false, reason: "expired" };

    this.touch(record.id, t);
    return { ok: true, principal: { id: record.id, name: record.name, scopes: toScopes(record.scopes) } };
  }

  /** Forget cached state for a token (used after an in-process revoke). */
  invalidate(id?: string): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }

  private async lookup(id: string): Promise<TokenRecord | undefined> {
    const ttl = this.options.cacheTtlMs;
    const t = this.now();
    if (ttl > 0) {
      const hit = this.cache.get(id);
      if (hit && t - hit.fetchedAt < ttl) return hit.record;
    }
    const record = await this.store.findById(id);
    if (ttl > 0) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.prune(t, ttl);
      this.cache.set(id, { record, fetchedAt: t });
    }
    return record;
  }

  private prune(t: number, ttl: number): void {
    for (const [k, v] of this.cache) if (t - v.fetchedAt >= ttl) this.cache.delete(k);
    // Still full (everything fresh): drop the oldest half rather than grow without bound.
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      let drop = Math.ceil(this.cache.size / 2);
      for (const k of this.cache.keys()) {
        if (drop-- <= 0) break;
        this.cache.delete(k);
      }
    }
  }

  private touch(id: string, t: number): void {
    const last = this.lastTouch.get(id) ?? 0;
    if (t - last < this.touchIntervalMs) return;
    this.lastTouch.set(id, t);
    // Best effort: a failed bookkeeping write must never block or fail a request.
    void this.store.touch(id, new Date(t)).catch(() => {});
  }

  private dummyCompare(value: string): void {
    timingSafeEqual(hashSecret(value), DUMMY_HASH);
  }
}
