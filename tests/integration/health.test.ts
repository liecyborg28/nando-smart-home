import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/config/env";
import { TokenAuthenticator } from "@/security/authentication";
import { InMemoryTokenStore } from "@/security/in-memory-token-store";
import { generateToken, scopesFor } from "@/security/token-store";

const state = vi.hoisted(() => ({ authenticator: undefined as unknown }));
vi.mock("@/http/context", () => ({ getHttpContext: () => ({ authenticator: state.authenticator }) }));

import { GET } from "@/app/api/health/route";

const original = { ...process.env };
let store: InMemoryTokenStore;
let validToken: string;

beforeEach(() => {
  store = new InMemoryTokenStore();
  const t = generateToken();
  store.seed({ id: t.id, name: "health-test", scopes: scopesFor("read"), secretHash: t.secretHash });
  validToken = t.token;
  state.authenticator = new TokenAuthenticator(store, { cacheTtlMs: 0 });
});

afterEach(() => {
  process.env = { ...original };
  resetEnvCache();
});

const req = (authorization?: string) => new Request("http://localhost/api/health", { headers: authorization ? { authorization } : {} });

describe("GET /api/health", () => {
  it("tells an anonymous caller only that the service is up", async () => {
    process.env.TUYA_ACCESS_ID = "my-id";
    process.env.TUYA_ACCESS_SECRET = "super-secret-value";
    process.env.DATABASE_URL_POOLED = "postgresql://user:hunter2@host/db";
    resetEnvCache();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", service: "nando-smart-home" });
    // Nothing about how the server is wired.
    expect(body.providers).toBeUndefined();
    expect(body.database).toBeUndefined();
    expect(body.control).toBeUndefined();
    const text = JSON.stringify(body);
    for (const secret of ["my-id", "super-secret-value", "hunter2"]) expect(text).not.toContain(secret);
  });

  it("shows configuration details to a valid token, still without any secret", async () => {
    process.env.TUYA_ACCESS_ID = "my-id";
    process.env.TUYA_ACCESS_SECRET = "super-secret-value";
    process.env.DATABASE_URL_POOLED = "postgresql://user:hunter2@host/db";
    resetEnvCache();
    const body = await (await GET(req(`Bearer ${validToken}`))).json();
    expect(body.providers.tuya.configured).toBe(true);
    expect(body.database.configured).toBe(true);
    expect(body.control.enabled).toBe(true);
    const text = JSON.stringify(body);
    for (const secret of ["my-id", "super-secret-value", "hunter2", validToken]) expect(text).not.toContain(secret);
  });

  it("reports Tuya as unconfigured when it is", async () => {
    delete process.env.TUYA_ACCESS_ID;
    delete process.env.TUYA_ACCESS_SECRET;
    resetEnvCache();
    expect((await (await GET(req(`Bearer ${validToken}`))).json()).providers.tuya.configured).toBe(false);
  });

  it("gives an invalid, revoked or unverifiable credential nothing beyond the anonymous answer", async () => {
    resetEnvCache();
    await store.revoke((await store.list())[0]!.id);
    for (const authorization of ["Bearer nsh_0000000000000000." + "x".repeat(43), `Bearer ${validToken}`, "Bearer junk"]) {
      const res = await GET(req(authorization));
      expect(res.status).toBe(200); // not an oracle: same answer as anonymous
      expect((await res.json()).providers).toBeUndefined();
    }
    store.failing = true;
    expect((await (await GET(req(`Bearer ${validToken}`))).json()).providers).toBeUndefined();
  });

  it("sends security headers and no caching", async () => {
    const res = await GET(req());
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns a safe error on invalid configuration", async () => {
    process.env.TUYA_BASE_URL = "https://evil.example.com";
    resetEnvCache();
    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("evil.example.com");
  });
});
