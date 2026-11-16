import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TuyaConfig } from "@/config/env";
import { TuyaClient } from "@/providers/tuya/tuya.client";
import { TuyaProvider } from "@/providers/tuya/tuya.provider";
import { contentSha256 } from "@/providers/tuya/tuya.sign";

const config: TuyaConfig = { accessId: "id", accessSecret: "the-secret", baseUrl: "https://openapi-sg.iotbing.com", timeoutMs: 5000 };

type Call = { url: URL; init: RequestInit };

function setup(commandResponse: (n: number) => unknown) {
  const calls: Call[] = [];
  let commandCalls = 0;
  let tokenCalls = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    if (url.pathname === "/v1.0/token") {
      tokenCalls++;
      return Response.json({ success: true, result: { access_token: `AT${tokenCalls}`, refresh_token: "RT", expire_time: 7200 } });
    }
    if (url.pathname.startsWith("/v1.0/token/")) return Response.json({ success: true, result: { access_token: "AT-REFRESHED", refresh_token: "RT2", expire_time: 7200 } });
    commandCalls++;
    return Response.json(commandResponse(commandCalls));
  });
  const client = new TuyaClient(config, { fetch: fetchMock as unknown as typeof fetch, now: () => 1_700_000_000_000, nonce: () => "n" });
  const posts = () => calls.filter((c) => c.init.method === "POST");
  return { provider: new TuyaProvider(client), posts, calls };
}

const COMMANDS = [{ code: "switch_led", value: true }, { code: "bright_value", value: 250 }];

describe("TuyaProvider.sendCommands", () => {
  it("POSTs {commands:[{code,value}]} to the device commands endpoint, signed with the body hash", async () => {
    const { provider, posts } = setup(() => ({ success: true, result: true, t: 1 }));
    await provider.sendCommands("lamp", COMMANDS);

    const [post] = posts();
    expect(post!.url.pathname).toBe("/v1.0/devices/lamp/commands");
    expect(post!.init.method).toBe("POST");
    const body = post!.init.body as string;
    expect(JSON.parse(body)).toEqual({ commands: [{ code: "switch_led", value: true }, { code: "bright_value", value: 250 }] });

    const h = post!.init.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("application/json");
    expect(h.access_token).toBe("AT1");
    const stringToSign = `POST\n${contentSha256(body)}\n\n/v1.0/devices/lamp/commands`;
    const expected = createHmac("sha256", config.accessSecret).update(`idAT11700000000000n${stringToSign}`).digest("hex").toUpperCase();
    expect(h.sign).toBe(expected);
  });

  it("strips anything beyond code and value from commands", async () => {
    const { provider, posts } = setup(() => ({ success: true, result: true }));
    await provider.sendCommands("lamp", [{ code: "a", value: 1, extra: "nope" } as never]);
    expect(JSON.parse(posts()[0]!.init.body as string)).toEqual({ commands: [{ code: "a", value: 1 }] });
  });

  it("treats result:false as a rejected command", async () => {
    const { provider } = setup(() => ({ success: true, result: false }));
    await expect(provider.sendCommands("lamp", COMMANDS)).rejects.toMatchObject({ code: "INVALID_DEVICE_COMMAND" });
  });

  it.each([
    [2008, "UNSUPPORTED_OPERATION"],
    [2003, "UNSUPPORTED_OPERATION"],
    [2001, "DEVICE_OFFLINE"],
    [2010, "DEVICE_NOT_FOUND"],
    [1106, "DEVICE_NOT_FOUND"],
    [40000308, "INVALID_DEVICE_COMMAND"],
    [1109, "INVALID_DEVICE_COMMAND"],
    [2051, "PROVIDER_UNAVAILABLE"],
    [1199, "PROVIDER_RATE_LIMITED"],
  ])("maps Tuya error %i to %s and never retries the write", async (providerCode, expected) => {
    const { provider, posts } = setup(() => ({ success: false, code: providerCode, msg: "provider text" }));
    const err = await provider.sendCommands("lamp", COMMANDS).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: expected });
    expect(JSON.stringify((err as { toSafe(): unknown }).toSafe())).not.toContain("provider text");
    expect(posts()).toHaveLength(1);
  });

  it("marks an IR send failure (2051) as retryable", async () => {
    const { provider } = setup(() => ({ success: false, code: 2051, msg: "x" }));
    await expect(provider.sendCommands("ir", COMMANDS)).rejects.toMatchObject({ retryable: true });
  });

  it("re-sends once with a fresh token only when Tuya says the token was rejected (nothing was executed)", async () => {
    const { provider, posts } = setup((n) => (n === 1 ? { success: false, code: 1010, msg: "token is expired" } : { success: true, result: true }));
    await provider.sendCommands("lamp", COMMANDS);
    expect(posts()).toHaveLength(2);
  });

  it.each(["../token", "a/b", "a?b=1", "", "x".repeat(65)])("rejects unsafe device id %j before any network call", async (bad) => {
    const { provider, calls } = setup(() => ({ success: true, result: true }));
    await expect(provider.sendCommands(bad, COMMANDS)).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    expect(calls).toEqual([]);
  });
});
