import { describe, expect, it, vi } from "vitest";
import type { TuyaConfig } from "@/config/env";
import { TuyaClient } from "@/providers/tuya/tuya.client";
import { TuyaProvider } from "@/providers/tuya/tuya.provider";

const config: TuyaConfig = {
  accessId: "id",
  accessSecret: "secret",
  baseUrl: "https://openapi-sg.iotbing.com",
  timeoutMs: 5000,
};

const SENSITIVE = ["LK-1", "LK-2", "198.51.100.9", "UID-PRIVATE"];

// Shapes mirror live responses (values synthetic).
const dev = (over: Record<string, unknown> = {}) => ({
  id: "ac1",
  name: "AC",
  category: "infrared_ac",
  product_name: "IR AC",
  online: true,
  sub: false,
  local_key: "LK-1",
  ip: "198.51.100.9",
  uid: "UID-PRIVATE",
  ...over,
});

type Route = (url: URL) => unknown | { __status: number; body: unknown };

function setup(route: Route) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    if (url.pathname === "/v1.0/token") {
      return Response.json({ success: true, result: { access_token: "AT", refresh_token: "RT", expire_time: 7200 } });
    }
    const out = route(url) as { __status?: number; body?: unknown };
    if (out && typeof out === "object" && "__status" in out) return Response.json(out.body, { status: out.__status });
    return Response.json(out);
  });
  const client = new TuyaClient(config, { fetch: fetchMock as unknown as typeof fetch, now: () => 1_700_000_000_000 });
  const provider = new TuyaProvider(client, () => new Date("2026-11-15T00:00:00Z"));
  return { provider, urls };
}

const ok = (result: unknown) => ({ success: true, result });
const fail = (code: number) => ({ success: false, code, msg: "provider text" });

describe("TuyaProvider.listDevices", () => {
  it("lists and maps devices without leaking sensitive provider fields", async () => {
    const { provider, urls } = setup(() =>
      ok({ devices: [dev(), dev({ id: "hub1", category: "wnykq", local_key: "LK-2" })], has_more: false, total: 2 }),
    );
    const devices = await provider.listDevices();
    expect(devices.map((d) => d.id)).toEqual(["ac1", "hub1"]);
    expect(devices[1]!.category.kind).toBe("remote");
    expect(urls.some((u) => u.startsWith("/v1.0/iot-01/associated-users/devices?size=20"))).toBe(true);
    const out = JSON.stringify(devices);
    for (const s of SENSITIVE) expect(out).not.toContain(s);
  });

  it("follows pagination with last_row_key until has_more is false", async () => {
    const { provider, urls } = setup((url) => {
      const key = url.searchParams.get("last_row_key");
      if (!key) return ok({ devices: [dev({ id: "a" })], has_more: true, last_row_key: "K1" });
      if (key === "K1") return ok({ devices: [dev({ id: "b" })], has_more: true, last_row_key: "K2" });
      return ok({ devices: [dev({ id: "c" })], has_more: false });
    });
    expect((await provider.listDevices()).map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(urls.filter((u) => u.includes("associated-users"))).toHaveLength(3);
  });

  it("stops at the page cap if the provider never ends pagination", async () => {
    const { provider, urls } = setup(() => ok({ devices: [dev()], has_more: true, last_row_key: "LOOP" }));
    await provider.listDevices();
    expect(urls.filter((u) => u.includes("associated-users")).length).toBe(50);
  });

  it("skips a single malformed entry instead of failing the whole listing", async () => {
    const { provider } = setup(() => ok({ devices: [dev({ id: "good" }), { name: "no id" }, 42], has_more: false }));
    expect((await provider.listDevices()).map((d) => d.id)).toEqual(["good"]);
  });

  it("returns an empty list when the account has no devices", async () => {
    const { provider } = setup(() => ok({ devices: [], has_more: false, total: 0 }));
    await expect(provider.listDevices()).resolves.toEqual([]);
  });

  it("rejects a malformed list payload with a safe error", async () => {
    const { provider } = setup(() => ok("nonsense"));
    await expect(provider.listDevices()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("TuyaProvider.getDevice / getDeviceStatus", () => {
  const isStatus = (url: URL) => url.pathname.endsWith("/status");

  it("returns details from the detail endpoint and status properties from the /status endpoint", async () => {
    const { provider, urls } = setup((url) => (isStatus(url) ? ok([{ code: "power", value: "1" }, { code: "temp", value: "24" }]) : ok(dev())));
    expect((await provider.getDevice("ac1")).name).toBe("AC");
    const status = await provider.getDeviceStatus("ac1");
    expect(status).toEqual({
      deviceId: "ac1",
      online: true,
      properties: [
        { code: "power", value: "1" },
        { code: "temp", value: "24" },
      ],
      retrievedAt: "2026-11-15T00:00:00.000Z",
    });
    expect(urls.filter((u) => !u.startsWith("/v1.0/token"))).toEqual(["/v1.0/devices/ac1", "/v1.0/devices/ac1", "/v1.0/devices/ac1/status"]);
    expect(JSON.stringify(status)).not.toContain("LK-1");
  });

  it("uses /status even when the detail carries an EMPTY status (the real infrared AC case)", async () => {
    const { provider } = setup((url) =>
      isStatus(url)
        ? ok([{ code: "power", value: "0" }, { code: "mode", value: "4" }, { code: "temp", value: "25" }, { code: "wind", value: "0" }])
        : ok(dev({ status: [] })),
    );
    const status = await provider.getDeviceStatus("ac1");
    expect(status.properties.map((p) => p.code)).toEqual(["power", "mode", "temp", "wind"]);
  });

  it("falls back to the status embedded in the detail when the device does not support /status (Tuya 2003)", async () => {
    const { provider } = setup((url) => (isStatus(url) ? fail(2003) : ok(dev({ status: [{ code: "power", value: "1" }] }))));
    expect((await provider.getDeviceStatus("hub1")).properties).toEqual([{ code: "power", value: "1" }]);
  });

  it("falls back to an empty list for such a device when the detail has no status either", async () => {
    const { provider } = setup((url) => (isStatus(url) ? fail(2003) : ok(dev({ status: [] }))));
    expect((await provider.getDeviceStatus("hub1")).properties).toEqual([]);
  });

  it.each([
    [1199, "PROVIDER_RATE_LIMITED"],
    [1106, "DEVICE_NOT_FOUND"],
    [2001, "DEVICE_OFFLINE"],
  ])("does NOT hide a real failure of /status behind the fallback (Tuya %i)", async (code, expected) => {
    const { provider } = setup((url) => (isStatus(url) ? fail(code) : ok(dev({ status: [{ code: "power", value: "1" }] }))));
    await expect(provider.getDeviceStatus("ac1")).rejects.toMatchObject({ code: expected });
  });

  it("rejects a malformed /status payload instead of guessing", async () => {
    const { provider } = setup((url) => (isStatus(url) ? ok({ not: "a list" }) : ok(dev())));
    await expect(provider.getDeviceStatus("ac1")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("reports offline devices as online=false (not an error)", async () => {
    const { provider } = setup((url) => (isStatus(url) ? ok([]) : ok(dev({ online: false }))));
    expect((await provider.getDeviceStatus("ac1")).online).toBe(false);
  });

  it("maps Tuya 1106 on a device call to DEVICE_NOT_FOUND", async () => {
    const { provider } = setup(() => fail(1106));
    const err = await provider.getDevice("nope").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "DEVICE_NOT_FOUND" });
    expect(JSON.stringify((err as { toSafe(): unknown }).toSafe())).not.toContain("provider text");
  });

  it("maps 2010 to DEVICE_NOT_FOUND and 2001 to DEVICE_OFFLINE", async () => {
    await expect(setup(() => fail(2010)).provider.getDevice("x")).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    await expect(setup(() => fail(2001)).provider.getDevice("x")).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });
  });

  it("rejects unsafe device ids before any provider call (path-injection guard)", async () => {
    const { provider, urls } = setup(() => ok(dev()));
    for (const bad of ["../token", "a/b", "a?b=1", "", "x".repeat(65), "id with space", "id%2f"]) {
      await expect(provider.getDevice(bad)).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    }
    expect(urls).toEqual([]);
  });
});

describe("TuyaProvider.getDeviceCapabilities", () => {
  it("maps a device specification into capabilities", async () => {
    const { provider } = setup(() =>
      ok({
        category: "infrared_ac",
        functions: [{ code: "T", type: "ENUM", values: '{"min":16,"max":30,"step":1,"scale":0}' }],
        status: [{ code: "power", type: "BOOLEAN", values: "{}" }],
      }),
    );
    const caps = await provider.getDeviceCapabilities("ac1");
    expect(caps.map((c) => [c.code, c.access])).toEqual([
      ["T", "write"],
      ["power", "read"],
    ]);
  });

  it("surfaces a device without a specification (Tuya 2009) as UNSUPPORTED_OPERATION", async () => {
    const { provider } = setup(() => fail(2009));
    await expect(provider.getDeviceCapabilities("hub1")).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });
});

describe("TuyaProvider.checkConnection", () => {
  it("reports connected after authenticating", async () => {
    const { provider } = setup(() => ok({}));
    await expect(provider.checkConnection()).resolves.toEqual({ provider: "tuya", connected: true });
  });
});
