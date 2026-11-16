import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API tokens: `nsh_<id>.<secret>`.
 *  - `id`     16 hex chars, public. Used to look the token up and to name it in audit logs.
 *  - `secret` 32 random bytes (base64url). Shown ONCE at creation; only its SHA-256 is stored.
 * Secrets are high-entropy random values, so a fast hash is appropriate (nothing to brute force).
 */

export type TokenScope = "read" | "write";

export interface TokenRecord {
  id: string;
  name: string;
  scopes: TokenScope[];
  secretHash: Buffer;
  createdAt: Date;
  createdBy: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
}

/** What may be listed or logged: never the hash. */
export type TokenSummary = Omit<TokenRecord, "secretHash">;

export interface NewToken {
  id: string;
  name: string;
  scopes: TokenScope[];
  secretHash: Buffer;
  createdBy?: string | null;
  expiresAt?: Date | null;
}

export interface TokenStore {
  create(token: NewToken): Promise<TokenSummary>;
  findById(id: string): Promise<TokenRecord | undefined>;
  list(): Promise<TokenSummary[]>;
  /** Returns false when the token does not exist or was already revoked. */
  revoke(id: string, reason?: string): Promise<boolean>;
  /** Revokes every active token. Returns how many. */
  revokeAll(reason?: string): Promise<number>;
  touch(id: string, at: Date): Promise<void>;
}

const TOKEN_PATTERN = /^nsh_([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;
export const TOKEN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export interface ParsedToken {
  id: string;
  secret: string;
}

/** Strict parse: anything not exactly this shape is rejected before touching the database. */
export function parseToken(value: string): ParsedToken | undefined {
  const m = TOKEN_PATTERN.exec(value);
  return m ? { id: m[1]!, secret: m[2]! } : undefined;
}

export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function safeEqualHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GeneratedToken {
  /** The full token. Show it to the operator once; it cannot be recovered afterwards. */
  token: string;
  id: string;
  secretHash: Buffer;
}

export function generateToken(): GeneratedToken {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { token: `nsh_${id}.${secret}`, id, secretHash: hashSecret(secret) };
}

export function scopesFor(level: "read" | "write"): TokenScope[] {
  // A controller must be able to inspect before it acts, so write implies read.
  return level === "write" ? ["read", "write"] : ["read"];
}

/** Used when no database is configured: every operation throws, so authentication fails closed. */
export class UnavailableTokenStore implements TokenStore {
  private fail(): never {
    throw new Error("token store is not configured");
  }
  async create(): Promise<TokenSummary> {
    return this.fail();
  }
  async findById(): Promise<TokenRecord | undefined> {
    return this.fail();
  }
  async list(): Promise<TokenSummary[]> {
    return this.fail();
  }
  async revoke(): Promise<boolean> {
    return this.fail();
  }
  async revokeAll(): Promise<number> {
    return this.fail();
  }
  async touch(): Promise<void> {
    return this.fail();
  }
}
