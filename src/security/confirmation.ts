import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import type { DeviceCommandItem, SmartHomeDevice } from "@/core/domain";
import { AppError } from "@/core/errors";

/**
 * Two-step confirmation for high-impact actions.
 *
 * 1. The first call is NOT executed; it returns a confirmation token.
 * 2. After the human agrees, the caller repeats the identical call with the token.
 *
 * The token is stateless (HMAC-signed), so it works with per-request MCP servers.
 * It binds actor + device + exact commands + expiry and can be used once, so it
 * cannot be replayed, reused for a different action, or used by another key.
 * Single-use tracking goes through a NonceStore: in memory for one process, or Postgres
 * so it holds across server instances. Limit (documented): the token proves a deliberate
 * second call, not that a human was asked; the Skills instruct agents to ask the user in between.
 */

export const CONFIRMATION_TTL_SECONDS = 300;

/** Best-effort defaults; configurable with HIGH_IMPACT_CATEGORIES. Door locks, garage doors, water valves. */
export const DEFAULT_HIGH_IMPACT_CATEGORIES = ["ms", "jtmspro", "jtmsbh", "ckmkzq", "sfkzq"];

/** Command codes that indicate a lock/valve/garage/siren style action, whatever the device category. */
const HIGH_IMPACT_CODE = /lock|valve|garage|siren/i;

export interface PolicyDecision {
  required: boolean;
  reason?: string;
}

export interface ConfirmationPolicy {
  evaluate(device: SmartHomeDevice, commands: DeviceCommandItem[]): PolicyDecision;
}

export function createConfirmationPolicy(options: { categories: string[]; confirmAll: boolean }): ConfirmationPolicy {
  const categories = new Set(options.categories.map((c) => c.trim().toLowerCase()).filter(Boolean));
  return {
    evaluate(device, commands) {
      if (options.confirmAll) return { required: true, reason: "The server requires confirmation for every control action." };
      if (categories.has(device.category.providerCode.toLowerCase())) {
        return { required: true, reason: `Devices of category "${device.category.providerCode}" are treated as high impact.` };
      }
      const risky = commands.find((c) => HIGH_IMPACT_CODE.test(c.code));
      if (risky) return { required: true, reason: `The command "${risky.code}" is treated as high impact.` };
      return { required: false };
    },
  };
}

interface Payload {
  a: string; // actor
  d: string; // device id
  c: string; // sha256 of canonical commands
  e: number; // expiry (ms since epoch)
  n: string; // nonce
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function fingerprint(commands: DeviceCommandItem[]): string {
  const canonical = [...commands].sort((x, y) => x.code.localeCompare(y.code)).map((c) => ({ code: c.code, value: c.value }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface ConfirmationBinding {
  actor: string;
  deviceId: string;
  commands: DeviceCommandItem[];
}

/** Records that a nonce was used. Resolves true only the FIRST time a nonce is seen. */
export interface NonceStore {
  markUsed(nonce: string, expiresAtMs: number): Promise<boolean>;
}

export class InMemoryNonceStore implements NonceStore {
  private readonly used = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async markUsed(nonce: string, expiresAtMs: number): Promise<boolean> {
    const t = this.now();
    for (const [n, expiry] of this.used) if (t > expiry) this.used.delete(n);
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, expiresAtMs);
    return true;
  }
}

/** Atomic across server instances: the primary key makes a second insert of the same nonce a no-op. */
export class PostgresNonceStore implements NonceStore {
  private lastPrune = 0;
  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = Date.now,
  ) {}

  async markUsed(nonce: string, expiresAtMs: number): Promise<boolean> {
    const t = this.now();
    if (t - this.lastPrune > 60_000) {
      this.lastPrune = t;
      void this.pool.query("delete from confirmation_nonces where expires_at < now()").catch(() => {});
    }
    const { rowCount } = await this.pool.query(
      "insert into confirmation_nonces (nonce, expires_at) values ($1, $2) on conflict (nonce) do nothing",
      [nonce, new Date(expiresAtMs)],
    );
    return rowCount === 1;
  }
}

export class ConfirmationManager {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
    private readonly ttlSeconds = CONFIRMATION_TTL_SECONDS,
    private readonly nonces: NonceStore = new InMemoryNonceStore(now),
  ) {
    // Derive a purpose-specific key so the configured secret is never used directly as an HMAC key.
    this.key = createHmac("sha256", secret).update("nando-smart-home/confirmation/v1").digest();
  }

  private sign(body: string): Buffer {
    return createHmac("sha256", this.key).update(body).digest();
  }

  issue(binding: ConfirmationBinding): { token: string; expiresInSeconds: number } {
    const payload: Payload = {
      a: binding.actor,
      d: binding.deviceId,
      c: fingerprint(binding.commands),
      e: this.now() + this.ttlSeconds * 1000,
      n: randomBytes(12).toString("base64url"),
    };
    const body = b64(JSON.stringify(payload));
    return { token: `${body}.${b64(this.sign(body))}`, expiresInSeconds: this.ttlSeconds };
  }

  /** Validates and consumes a token. Throws AUTHORIZATION_FAILED with a coarse reason otherwise. */
  async consume(token: string, binding: ConfirmationBinding): Promise<void> {
    const fail = (reason: string): never => {
      throw new AppError("AUTHORIZATION_FAILED", "The confirmation token is invalid, expired, already used, or does not match this action.", {
        context: { reason },
      });
    };

    const [body, sig, extra] = token.split(".");
    if (!body || !sig || extra !== undefined) return fail("malformed");
    const expected = this.sign(body);
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fail("invalid");

    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    } catch {
      return fail("malformed");
    }

    const t = this.now();
    if (typeof payload.e !== "number" || t > payload.e) return fail("expired");
    if (payload.a !== binding.actor || payload.d !== binding.deviceId || payload.c !== fingerprint(binding.commands)) return fail("mismatch");

    let firstUse: boolean;
    try {
      firstUse = await this.nonces.markUsed(payload.n, payload.e);
    } catch {
      // Cannot prove single use right now: refuse (fail closed) rather than risk a replay.
      throw new AppError("PROVIDER_UNAVAILABLE", "The confirmation could not be verified right now. Try again shortly.", { retryable: true });
    }
    if (!firstUse) return fail("used");
  }
}
