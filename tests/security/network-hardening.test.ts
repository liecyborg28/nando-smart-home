import { afterEach, describe, expect, it } from "vitest";
import { MCP_HANDLER_LIMITS } from "@/mcp/limits";
import { clientIp, isDirectLocalRequest, requestProtocol } from "@/security/request-context";
import { ConcurrencyLimiter, FixedWindowRateLimiter } from "@/security/rate-limit";
import { READ_ID, READ_KEY, WRITE_KEY, createHarness, type Harness } from "../helpers/mcp-harness";
import { smartFleet, testControlDeps } from "../helpers/smart-fleet";

let h: Harness;
afterEach(async () => h?.close());

const PING = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
const send = (headers: Record<string, string> = {}, body = PING, path = "/mcp") =>
  h.http(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });
const authed = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${READ_KEY}`, ...extra });

const PROD = { NODE_ENV: "production", MCP_ALLOWED_HOSTS: "home.example.com", MCP_ALLOWED_ORIGINS: "home.example.com" };

describe("client IP and protocol resolution", () => {
  const req = (headers: Record<string, string>, url = "http://app.internal/mcp") => new Request(url, { headers });

  it("ignores forwarding headers entirely when no proxy is trusted", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6" }), 0)).toBe("direct");
    expect(requestProtocol(req({ "x-forwarded-proto": "https" }), 0)).toBe("http");
  });

  it("takes the address our own proxy appended (rightmost), so a forged left part is useless", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), 1)).toBe("203.0.113.9");
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" }), 2)).toBe("203.0.113.9");
  });

  it("falls back to 'unknown' for missing or malformed values behind a proxy", () => {
    expect(clientIp(req({}), 1)).toBe("unknown");
    expect(clientIp(req({ "x-forwarded-for": "not an ip!" }), 1)).toBe("unknown");
    expect(clientIp(req({ "x-forwarded-for": "<script>" }), 1)).toBe("unknown");
  });

  it("trusts X-Forwarded-Proto only behind a trusted proxy", () => {
    expect(requestProtocol(req({ "x-forwarded-proto": "https" }), 1)).toBe("https");
    expect(requestProtocol(req({}, "https://app.example/mcp"), 0)).toBe("https");
    expect(requestProtocol(req({ "x-forwarded-proto": "ftp" }), 1)).toBe("http");
  });

  it("treats only direct loopback requests as local", () => {
    expect(isDirectLocalRequest(req({ host: "localhost:3000" }), 0)).toBe(true);
    expect(isDirectLocalRequest(req({ host: "127.0.0.1" }), 0)).toBe(true);
    expect(isDirectLocalRequest(req({ host: "localhost" }), 1)).toBe(false); // via a proxy: not local
    expect(isDirectLocalRequest(req({ host: "evil.example.com" }), 0)).toBe(false);
  });
});

describe("HTTPS enforcement", () => {
  it("refuses plain HTTP in production (403, never a redirect) before looking at the token", async () => {
    h = createHarness({ env: PROD });
    const res = await send(authed({ host: "home.example.com" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect((await res.json()).error.message).toMatch(/HTTPS is required/);
  });

  it("accepts HTTPS reported by a trusted proxy", async () => {
    h = createHarness({ env: { ...PROD, TRUSTED_PROXY_HOPS: "1" } });
    const res = await send(authed({ host: "home.example.com", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" }));
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("does not believe a forged X-Forwarded-Proto when no proxy is trusted", async () => {
    h = createHarness({ env: PROD });
    expect((await send(authed({ host: "home.example.com", "x-forwarded-proto": "https" }))).status).toBe(403);
  });

  it("allows direct localhost use even in production (local debugging), but not through a proxy", async () => {
    h = createHarness({ env: { ...PROD, MCP_ALLOWED_HOSTS: "localhost" , MCP_ALLOWED_ORIGINS: "localhost" } });
    expect((await send(authed({ host: "localhost" }))).status).not.toBe(403);
    await h.close();
    h = createHarness({ env: { ...PROD, MCP_ALLOWED_HOSTS: "localhost", MCP_ALLOWED_ORIGINS: "localhost", TRUSTED_PROXY_HOPS: "1" } });
    expect((await send(authed({ host: "localhost", "x-forwarded-for": "203.0.113.9" }))).status).toBe(403);
  });

  it("is off by default outside production", async () => {
    h = createHarness();
    expect((await send(authed())).status).not.toBe(403);
  });
});

describe("security headers", () => {
  it("are present on every kind of response: success, auth failure, HTTPS refusal, rate limit", async () => {
    h = createHarness({ env: PROD, ipRateLimit: 4 });
    const responses = [
      await send({ host: "home.example.com" }), // 403 https refusal
      await send({ host: "home.example.com", authorization: "Bearer junk" }),
      await send({ host: "home.example.com" }),
      await send({ host: "home.example.com" }),
      await send({ host: "home.example.com" }), // 429 per-IP limit
    ];
    expect(responses.map((r) => r.status)).toContain(429);
    for (const res of responses) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("strict-transport-security")).toContain("max-age=");
      expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("also covers the SDK's own responses, and request ids are unique", async () => {
    h = createHarness();
    const a = await send(authed());
    const b = await send(authed());
    expect(a.status).toBe(200);
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
    expect(a.headers.get("strict-transport-security")).toBeNull(); // plain-HTTP dev: no HSTS
  });

  it("carries the request id, client IP and user agent into the audit trail", async () => {
    h = createHarness({ env: { TRUSTED_PROXY_HOPS: "1" } });
    const client = await h.connect(); // goes through http() without proxy headers => 'unknown'
    await client.callTool({ name: "get_device", arguments: { deviceId: "ac1" } });
    const entry = h.audit.find((e) => e.action === "tool:get_device");
    expect(entry).toMatchObject({ actor: READ_ID, clientIp: "unknown" });
    expect(entry?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("per-IP limits (before authentication)", () => {
  it("throttles an IP even when it sends invalid tokens, so floods stay cheap", async () => {
    h = createHarness({ env: { TRUSTED_PROXY_HOPS: "1" }, ipRateLimit: 5 });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await send({ authorization: "Bearer junk", "x-forwarded-for": "198.51.100.7" })).status);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
  });

  it("is per IP: one noisy address does not lock out another", async () => {
    h = createHarness({ env: { TRUSTED_PROXY_HOPS: "1" }, ipRateLimit: 3 });
    for (let i = 0; i < 6; i++) await send({ authorization: "Bearer junk", "x-forwarded-for": "198.51.100.7" });
    expect((await send(authed({ "x-forwarded-for": "203.0.113.50" }))).status).toBe(200);
  });

  it("a forged left-hand X-Forwarded-For entry cannot dodge the limit", async () => {
    h = createHarness({ env: { TRUSTED_PROXY_HOPS: "1" }, ipRateLimit: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await send({ authorization: "Bearer junk", "x-forwarded-for": `10.0.0.${i}, 198.51.100.7` })).status);
    expect(statuses.slice(3).every((c) => c === 429)).toBe(true);
  });

  it("failed authentications are throttled per IP, not globally", async () => {
    h = createHarness({ env: { TRUSTED_PROXY_HOPS: "1" } });
    const attacker = { authorization: "Bearer junk", "x-forwarded-for": "198.51.100.7" };
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await send(attacker)).status);
    expect(codes.slice(20).every((c) => c === 429)).toBe(true);
    expect((await send(authed({ "x-forwarded-for": "203.0.113.50" }))).status).toBe(200); // honest user elsewhere is fine
    expect((await send({ authorization: "Bearer junk", "x-forwarded-for": "203.0.113.51" })).status).toBe(401); // other IP not throttled yet
  });
});

describe("concurrency and request size limits", () => {
  it("refuses a token's extra simultaneous requests and frees the slot afterwards", async () => {
    h = createHarness({ maxConcurrent: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const originalFetch = h.deps.handler.fetch;
    h.deps.handler.fetch = async (...args) => {
      await gate;
      return originalFetch(...args);
    };
    const first = send(authed());
    const second = send(authed());
    await new Promise((r) => setTimeout(r, 20));
    const third = await send(authed());
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("1");
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await send(authed())).status).toBe(200);
  });

  it("releases the slot even when the handler throws", async () => {
    h = createHarness({ maxConcurrent: 1 });
    const originalFetch = h.deps.handler.fetch;
    h.deps.handler.fetch = async () => {
      throw new Error("boom: secret=abc");
    };
    const res = await send(authed());
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret=abc");
    h.deps.handler.fetch = originalFetch;
    expect((await send(authed())).status).toBe(200);
  });

  it("enforces the shipped body-size limit", async () => {
    h = createHarness();
    const limit = MCP_HANDLER_LIMITS.maxRequestBodySize;
    const pad = (n: number) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(n) } });
    expect((await send(authed(), pad(limit + 1024))).status).toBe(413);
    expect((await send(authed(), pad(1024))).status).not.toBe(413);
  });

  it("keeps the SSE subscription cap small", () => {
    expect(MCP_HANDLER_LIMITS.maxSubscriptions).toBeLessThanOrEqual(16);
  });
});

describe("usage budget (cost-weighted)", () => {
  it("charges batch reads by fan-out so one call cannot burn the provider quota", async () => {
    h = createHarness({ budget: 20 });
    const client = await h.connect();
    const ids = ["ac1", "hub1"];
    // 2 ids x 2 provider calls = cost 4
    for (let i = 0; i < 5; i++) expect((await client.callTool({ name: "get_multiple_device_status", arguments: { deviceIds: ids } })).isError).toBeFalsy();
    const over = await client.callTool({ name: "get_multiple_device_status", arguments: { deviceIds: ids } });
    expect(over.isError).toBe(true);
    expect(JSON.stringify(over)).toContain("PROVIDER_RATE_LIMITED");
  });

  it("charges the expensive capability catalog resource heavily", async () => {
    h = createHarness({ budget: 30 });
    const client = await h.connect();
    await client.readResource({ uri: "smarthome://capabilities" }); // cost 25
    await expect(client.readResource({ uri: "smarthome://capabilities" })).rejects.toThrow(); // 50 > 30
  });

  it("is per token, and a refused call does not run the provider", async () => {
    const fleet = smartFleet();
    h = createHarness({ provider: fleet.provider, control: testControlDeps(), budget: 6 });
    const write = await h.connect(WRITE_KEY);
    const read = await h.connect();
    expect((await write.callTool({ name: "set_device_property", arguments: { deviceId: "lamp", code: "bright_value", value: 100 } })).isError).toBeFalsy(); // cost 6
    const refused = await write.callTool({ name: "set_device_property", arguments: { deviceId: "lamp", code: "bright_value", value: 200 } });
    expect(refused.isError).toBe(true);
    expect(fleet.sent).toHaveLength(1);
    expect((await read.callTool({ name: "list_devices", arguments: {} })).isError).toBeFalsy(); // other token has its own budget
  });
});

describe("limiter primitives", () => {
  it("FixedWindowRateLimiter honours cost", () => {
    const lim = new FixedWindowRateLimiter(10, 1000, () => 0);
    expect(lim.hit("k", 6).allowed).toBe(true);
    expect(lim.hit("k", 4).allowed).toBe(true);
    expect(lim.hit("k", 1).allowed).toBe(false);
  });

  it("ConcurrencyLimiter releases exactly once", () => {
    const lim = new ConcurrencyLimiter(1);
    const release = lim.acquire("k")!;
    expect(lim.acquire("k")).toBeUndefined();
    release();
    release(); // double release must not free a second slot
    expect(lim.acquire("k")).toBeDefined();
    expect(lim.acquire("k")).toBeUndefined();
  });
});
