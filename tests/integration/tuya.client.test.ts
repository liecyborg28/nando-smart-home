import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TuyaConfig } from "@/config/env";
import { AppError } from "@/core/errors";
import { TuyaClient } from "@/providers/tuya/tuya.client";
import { EMPTY_BODY_SHA256 } from "@/providers/tuya/tuya.sign";

const config: TuyaConfig = {
  accessId: "test-access-id",
  accessSecret: "test-access-secret-DO-NOT-LEAK",
  baseUrl: "https://openapi-sg.iotbing.com",
  timeoutMs: 5000,
};

const TOKEN_BODY = { success: true, t: 1, result: { access_token: "AT1", refresh_token: "RT1", expire_time: 7200, uid: "u1" } };

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeClient(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  });
  const client = new TuyaClient(config, {
    fetch: fetchMock as unknown as typeof fetch,
    now: () => 1_700_000_000_000,
    nonce: () => "fixed-nonce",
  });
  return { client, calls, fetchMock };
}

const isToken = (url: string) => url.includes("/v1.0/token");

describe("TuyaClient", () => {
  it("signs and sends the token request to the configured host with documented headers", async () => {
    const { client, calls } = makeClient(() => json(TOKEN_BODY));
    await client.verifyConnection();

    const { url, init } = calls[0]!;
    expect(url).toBe("https://openapi-sg.iotbing.com/v1.0/token?grant_type=1");
    const h = init.headers as Record<string, string>;
    expect(h).toMatchObject({
      client_id: "test-access-id",
      t: "1700000000000",
      nonce: "fixed-nonce",
      sign_method: "HMAC-SHA256",
    });
    expect(h.access_token).toBeUndefined(); // token requests are sent without a token

    const stringToSign = `GET\n${EMPTY_BODY_SHA256}\n\n/v1.0/token?grant_type=1`;
    const expected = createHmac("sha256", config.accessSecret)
      .update(`test-access-id1700000000000fixed-nonce${stringToSign}`)
      .digest("hex")
      .toUpperCase();
    expect(h.sign).toBe(expected);
  });

  it("sends business requests with access_token included in the signature", async () => {
    const { client, calls } = makeClient((url) => (isToken(url) ? json(TOKEN_BODY) : json({ success: true, result: { ok: 1 } })));
    const result = await client.request<{ ok: number }>({ method: "GET", path: "/v1.0/devices/abc", query: { b: 2, a: 1 } });
    expect(result).toEqual({ ok: 1 });

    const { url, init } = calls[1]!;
    expect(url).toBe("https://openapi-sg.iotbing.com/v1.0/devices/abc?a=1&b=2");
    const h = init.headers as Record<string, string>;
    expect(h.access_token).toBe("AT1");
    const stringToSign = `GET\n${EMPTY_BODY_SHA256}\n\n/v1.0/devices/abc?a=1&b=2`;
    const expected = createHmac("sha256", config.accessSecret)
      .update(`test-access-idAT11700000000000fixed-nonce${stringToSign}`)
      .digest("hex")
      .toUpperCase();
    expect(h.sign).toBe(expected);
  });

  it("accepts a bare (unwrapped) token response", async () => {
    const { client } = makeClient(() => json(TOKEN_BODY.result));
    await expect(client.verifyConnection()).resolves.toMatchObject({ connected: true, tokenValidForSeconds: 7200 });
  });

  it("retries exactly once with a fresh token when Tuya reports the token expired", async () => {
    let businessCalls = 0;
    let tokenCalls = 0;
    const { client } = makeClient((url) => {
      if (url.includes("/v1.0/token/")) {
        return json({ success: true, result: { access_token: "AT2", refresh_token: "RT2", expire_time: 7200 } });
      }
      if (isToken(url)) {
        tokenCalls++;
        return json(TOKEN_BODY);
      }
      businessCalls++;
      return businessCalls === 1 ? json({ success: false, code: 1010, msg: "token is expired" }) : json({ success: true, result: "done" });
    });
    await expect(client.request({ method: "GET", path: "/v1.0/x" })).resolves.toBe("done");
    expect(businessCalls).toBe(2);
    expect(tokenCalls).toBe(1);
  });

  it("does not retry a second time if the token is still rejected", async () => {
    let businessCalls = 0;
    const { client } = makeClient((url) => {
      if (url.includes("/v1.0/token/")) {
        return json({ success: true, result: { access_token: "AT2", refresh_token: "RT2", expire_time: 7200 } });
      }
      if (isToken(url)) return json(TOKEN_BODY);
      businessCalls++;
      return json({ success: false, code: 1011, msg: "token invalid" });
    });
    await expect(client.request({ method: "GET", path: "/v1.0/x" })).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(businessCalls).toBe(2);
  });

  it.each([
    [1004, "AUTHENTICATION_FAILED"],
    [1005, "AUTHENTICATION_FAILED"],
    [1013, "AUTHENTICATION_FAILED"],
    [1106, "AUTHORIZATION_FAILED"],
    [28841105, "AUTHORIZATION_FAILED"],
    [1199, "PROVIDER_RATE_LIMITED"],
    [424242, "PROVIDER_UNAVAILABLE"],
  ])("translates Tuya error code %i to %s", async (code, expected) => {
    const { client } = makeClient(() => json({ success: false, code, msg: "provider text with secret-ish detail" }));
    const err = await client.verifyConnection().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(expected);
    expect((err as AppError).toSafe().context).toEqual({ providerCode: code });
    expect(JSON.stringify((err as AppError).toSafe())).not.toContain("provider text");
  });

  it("maps HTTP 5xx to PROVIDER_UNAVAILABLE and 429 to PROVIDER_RATE_LIMITED", async () => {
    await expect(makeClient(() => json({}, 503)).client.verifyConnection()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(makeClient(() => json({}, 429)).client.verifyConnection()).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
  });

  it("maps timeouts to REQUEST_TIMEOUT and network failures to PROVIDER_UNAVAILABLE", async () => {
    const timeout = makeClient(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await expect(timeout.client.verifyConnection()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", retryable: true });

    const down = makeClient(() => {
      throw new TypeError("fetch failed");
    });
    await expect(down.client.verifyConnection()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("rejects malformed token payloads without echoing them", async () => {
    const { client } = makeClient(() => json({ success: true, result: { access_token: "LEAKY-TOKEN" } }));
    const err = await client.verifyConnection().catch((e: unknown) => e);
    expect((err as AppError).code).toBe("PROVIDER_UNAVAILABLE");
    expect(JSON.stringify((err as AppError).toSafe())).not.toContain("LEAKY-TOKEN");
  });

  it("never leaks the secret, signature or tokens in safe errors", async () => {
    const { client } = makeClient((url) => (isToken(url) ? json(TOKEN_BODY) : json({ success: false, code: 1004, msg: "sign invalid" })));
    const err = await client.request({ method: "GET", path: "/v1.0/x" }).catch((e: unknown) => e);
    const out = JSON.stringify((err as AppError).toSafe());
    for (const secret of [config.accessSecret, "AT1", "RT1"]) expect(out).not.toContain(secret);
  });

  it("shares one token request across concurrent business calls", async () => {
    let tokenCalls = 0;
    const { client } = makeClient(async (url) => {
      if (isToken(url)) {
        tokenCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return json(TOKEN_BODY);
      }
      return json({ success: true, result: 1 });
    });
    await Promise.all(Array.from({ length: 10 }, () => client.request({ method: "GET", path: "/v1.0/x" })));
    expect(tokenCalls).toBe(1);
  });
});
