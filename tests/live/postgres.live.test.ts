import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@/db/migrate";
import { createPool, normalizeDatabaseUrl } from "@/db/pool";
import { TokenAuthenticator } from "@/security/authentication";
import { PostgresNonceStore } from "@/security/confirmation";
import { PostgresTokenStore } from "@/security/postgres-token-store";
import { generateToken, hashSecret, scopesFor } from "@/security/token-store";

/**
 * LIVE Postgres test. Everything happens inside a throw-away schema that is created
 * first and dropped afterwards, so no real data is touched. Needs DATABASE_URL (direct).
 */
try {
  process.loadEnvFile(".env");
} catch {}

const url = process.env.DATABASE_URL;
const schema = `nsh_test_${randomBytes(4).toString("hex")}`;
let admin: Pool;
let pool: Pool;
let store: PostgresTokenStore;

describe.skipIf(!url)("Postgres token store (temporary schema)", () => {
  beforeAll(async () => {
    admin = createPool(url!, { max: 1 });
    await admin.query(`create schema ${schema}`);
    pool = createPool(url!, { max: 4, schema });
    const result = await runMigrations(pool);
    expect(result.applied).toEqual(["001_init.sql"]);
    store = new PostgresTokenStore(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    await admin?.end().catch(() => {});
  }, 60_000);

  it("is idempotent: running migrations again applies nothing", async () => {
    expect(await runMigrations(pool)).toEqual({ applied: [], alreadyApplied: ["001_init.sql"] });
  });

  it("uses verify-full instead of the ambiguous sslmode=require", () => {
    expect(normalizeDatabaseUrl("postgresql://u:p@h/db?sslmode=require&channel_binding=require")).toContain("sslmode=verify-full");
  });

  it("creates a token, stores only the hash, and finds it again", async () => {
    const gen = generateToken();
    const created = await store.create({ id: gen.id, name: "live-test", scopes: scopesFor("write"), secretHash: gen.secretHash, createdBy: "test" });
    expect(created).toMatchObject({ id: gen.id, name: "live-test", scopes: ["read", "write"], revokedAt: null, expiresAt: null });
    expect(Object.keys(created)).not.toContain("secretHash");

    const found = await store.findById(gen.id);
    const secret = gen.token.split(".")[1]!;
    expect(found!.secretHash.equals(hashSecret(secret))).toBe(true);

    const raw = await pool.query("select * from api_tokens where id = $1", [gen.id]);
    expect(JSON.stringify(raw.rows)).not.toContain(secret);
  });

  it("revokes a token (once), and revoke-all cuts off the rest", async () => {
    const a = generateToken();
    const b = generateToken();
    await store.create({ id: a.id, name: "a", scopes: scopesFor("read"), secretHash: a.secretHash });
    await store.create({ id: b.id, name: "b", scopes: scopesFor("read"), secretHash: b.secretHash });
    expect(await store.revoke(a.id, "test")).toBe(true);
    expect(await store.revoke(a.id)).toBe(false);
    expect((await store.findById(a.id))!.revokedReason).toBe("test");
    expect(await store.revokeAll("incident")).toBeGreaterThanOrEqual(1);
    expect((await store.findById(b.id))!.revokedAt).toBeInstanceOf(Date);
  });

  it("database constraints reject malformed rows even if application checks were bypassed", async () => {
    const h = hashSecret("x");
    await expect(store.create({ id: "not-hex", name: "x", scopes: ["read"], secretHash: h })).rejects.toThrow();
    await expect(store.create({ id: "aaaaaaaaaaaaaaaa", name: "", scopes: ["read"], secretHash: h })).rejects.toThrow();
    await expect(store.create({ id: "bbbbbbbbbbbbbbbb", name: "x", scopes: ["admin" as never], secretHash: h })).rejects.toThrow();
    await expect(store.create({ id: "cccccccccccccccc", name: "x", scopes: [], secretHash: h })).rejects.toThrow();
    await expect(store.create({ id: "dddddddddddddddd", name: "x", scopes: ["read"], secretHash: Buffer.from("short") })).rejects.toThrow();
  });

  it("is not injectable: hostile ids are treated as plain data", async () => {
    expect(await store.findById("' or 1=1; drop table api_tokens; --")).toBeUndefined();
    expect(await store.revoke("x'; delete from api_tokens; --")).toBe(false);
    const { rows } = await pool.query("select count(*)::int as n from api_tokens");
    expect(rows[0].n).toBeGreaterThan(0); // table still there and populated
  });

  it("authenticates end to end and honours revocation", async () => {
    const gen = generateToken();
    await store.create({ id: gen.id, name: "e2e", scopes: scopesFor("read"), secretHash: gen.secretHash });
    const auth = new TokenAuthenticator(store, { cacheTtlMs: 0 });
    const req = (t: string) => new Request("http://x/mcp", { headers: { authorization: `Bearer ${t}` } });

    expect(await auth.authenticate(req(gen.token))).toMatchObject({ ok: true, principal: { id: gen.id, name: "e2e" } });
    expect(await auth.authenticate(req(gen.token.replace(/.$/, (c) => (c === "A" ? "B" : "A"))))).toMatchObject({ ok: false, reason: "invalid" });
    await store.revoke(gen.id);
    expect(await auth.authenticate(req(gen.token))).toEqual({ ok: false, reason: "revoked" });
  });

  it("confirmation nonces are single use, atomically, even under concurrency", async () => {
    const nonces = new PostgresNonceStore(pool);
    const nonce = randomBytes(8).toString("hex");
    const results = await Promise.all(Array.from({ length: 20 }, () => nonces.markUsed(nonce, Date.now() + 60_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("authentication fails CLOSED when the database is unreachable", async () => {
    const dead = createPool(url!, { max: 1, schema });
    await dead.end();
    const auth = new TokenAuthenticator(new PostgresTokenStore(dead), { cacheTtlMs: 0 });
    const gen = generateToken();
    const res = await auth.authenticate(new Request("http://x/mcp", { headers: { authorization: `Bearer ${gen.token}` } }));
    expect(res).toEqual({ ok: false, reason: "store_unavailable" });
  });
});
