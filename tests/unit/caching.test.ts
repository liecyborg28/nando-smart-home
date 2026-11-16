import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/core/errors";
import { TtlCache } from "@/lib/ttl-cache";
import { CachingProvider } from "@/providers/caching-provider";
import type { SmartHomeProvider } from "@/providers/provider.interface";
import { createServices } from "@/services/container";
import { smartFleet, testControlDeps } from "../helpers/smart-fleet";

describe("TtlCache", () => {
  it("serves a value until the TTL passes, then reloads", async () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, () => now);
    const load = vi.fn(async () => load.mock.calls.length);
    expect(await cache.get("k", load)).toBe(1);
    expect(await cache.get("k", load)).toBe(1);
    now = 1001;
    expect(await cache.get("k", load)).toBe(2);
  });

  it("shares ONE load between concurrent callers", async () => {
    const cache = new TtlCache<string>(1000);
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return "v";
    };
    const results = await Promise.all(Array.from({ length: 25 }, () => cache.get("k", load)));
    expect(new Set(results)).toEqual(new Set(["v"]));
    expect(calls).toBe(1);
  });

  it("never caches a failure, and a failed load does not poison the next call", async () => {
    const cache = new TtlCache<string>(1000);
    let fail = true;
    const load = async () => {
      if (fail) throw new Error("boom");
      return "ok";
    };
    await expect(cache.get("k", load)).rejects.toThrow("boom");
    fail = false;
    expect(await cache.get("k", load)).toBe("ok");
  });

  it("fresh bypasses the cache and refreshes it", async () => {
    const cache = new TtlCache<number>(60_000);
    let n = 0;
    const load = async () => ++n;
    expect(await cache.get("k", load)).toBe(1);
    expect(await cache.get("k", load, { fresh: true })).toBe(2);
    expect(await cache.get("k", load)).toBe(2);
  });

  it("with TTL 0 it only de-duplicates, never stores", async () => {
    const cache = new TtlCache<number>(0);
    let n = 0;
    expect(await cache.get("k", async () => ++n)).toBe(1);
    expect(await cache.get("k", async () => ++n)).toBe(2);
  });

  it("is bounded", async () => {
    const cache = new TtlCache<number>(60_000, Date.now, 3);
    for (let i = 0; i < 10; i++) await cache.get(`k${i}`, async () => i);
    let reloaded = 0;
    await cache.get("k0", async () => ++reloaded);
    expect(reloaded).toBe(1); // oldest entries were evicted
  });
});

function counting(fleet = smartFleet()) {
  const calls = { list: 0, device: 0, status: 0, caps: 0, send: 0, check: 0 };
  const inner: SmartHomeProvider = {
    ...fleet.provider,
    checkConnection: async () => (calls.check++, fleet.provider.checkConnection()),
    listDevices: async () => (calls.list++, fleet.provider.listDevices()),
    getDevice: async (id) => (calls.device++, fleet.provider.getDevice(id)),
    getDeviceStatus: async (id) => (calls.status++, fleet.provider.getDeviceStatus(id)),
    getDeviceCapabilities: async (id) => (calls.caps++, fleet.provider.getDeviceCapabilities(id)),
    sendCommands: async (id, c) => (calls.send++, fleet.provider.sendCommands(id, c)),
  };
  return { inner, calls, fleet };
}

describe("CachingProvider", () => {
  it("collapses repeated reads into one provider call each, with the documented lifetimes", async () => {
    let now = 0;
    const { inner, calls } = counting();
    const p = new CachingProvider(inner, { listMs: 15_000, deviceMs: 15_000, statusMs: 3_000, capabilitiesMs: 600_000 }, () => now);
    for (let i = 0; i < 10; i++) {
      await p.listDevices();
      await p.getDevice("lamp");
      await p.getDeviceStatus("lamp");
      await p.getDeviceCapabilities("lamp");
    }
    expect(calls).toMatchObject({ list: 1, device: 1, status: 1, caps: 1 });
    now = 4_000;
    await p.getDeviceStatus("lamp");
    await p.getDevice("lamp");
    expect(calls).toMatchObject({ status: 2, device: 1 }); // status expired (3s), device did not (15s)
    now = 20_000;
    await p.listDevices();
    await p.getDeviceCapabilities("lamp");
    expect(calls).toMatchObject({ list: 2, caps: 1 }); // capabilities live for 10 minutes
  });

  it("a second batch of 20 status reads costs the provider nothing", async () => {
    const { inner, calls } = counting();
    const p = new CachingProvider(inner);
    const svc = createServices(p, testControlDeps()).status;
    const ids = ["lamp", "lamp2", "ir-ac", "door", "sensor", "multi"];
    await svc.getMultipleStatus(ids);
    const first = calls.status;
    await svc.getMultipleStatus(ids);
    await svc.getMultipleStatus(ids);
    expect(first).toBe(ids.length);
    expect(calls.status).toBe(first);
  });

  it("never caches a provider error", async () => {
    let fail = true;
    const { inner } = counting();
    const flaky: SmartHomeProvider = { ...inner, listDevices: async () => (fail ? Promise.reject(new AppError("PROVIDER_UNAVAILABLE", "down")) : inner.listDevices()) };
    const p = new CachingProvider(flaky);
    await expect(p.listDevices()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    fail = false;
    expect(await p.listDevices()).toHaveLength(6);
  });

  it("fresh reads always reach the provider", async () => {
    const { inner, calls } = counting();
    const p = new CachingProvider(inner);
    await p.getDeviceStatus("lamp");
    await p.getDeviceStatus("lamp", { fresh: true });
    await p.getDeviceStatus("lamp", { fresh: true });
    expect(calls.status).toBe(3);
  });

  it("a command invalidates that device's cached state and the list, but not other devices", async () => {
    const { inner, calls } = counting();
    const p = new CachingProvider(inner);
    await p.getDeviceStatus("lamp");
    await p.getDeviceStatus("door");
    await p.listDevices();
    await p.sendCommands("lamp", [{ code: "switch_led", value: true }]);
    expect((await p.getDeviceStatus("lamp")).properties.find((x) => x.code === "switch_led")?.value).toBe(true); // not the stale false
    await p.getDeviceStatus("door");
    await p.listDevices();
    expect(calls.status).toBe(3); // lamp re-read; door still cached
    expect(calls.list).toBe(2);
  });

  it("invalidates even when the command fails (it may have partly applied)", async () => {
    const { inner, calls } = counting();
    const failing: SmartHomeProvider = { ...inner, sendCommands: async () => Promise.reject(new AppError("PROVIDER_UNAVAILABLE", "x")) };
    const p = new CachingProvider(failing);
    await p.getDeviceStatus("lamp");
    await expect(p.sendCommands("lamp", [{ code: "switch_led", value: true }])).rejects.toThrow();
    await p.getDeviceStatus("lamp");
    expect(calls.status).toBe(2);
  });

  it("does not cache the connection check", async () => {
    const { inner, calls } = counting();
    const p = new CachingProvider(inner);
    await p.checkConnection();
    await p.checkConnection();
    expect(calls.check).toBe(2);
  });
});

describe("control reads live state through the cache", () => {
  it("verification sees the NEW state, not a stale cached one, and the offline check is live", async () => {
    const { inner, calls } = counting();
    const p = new CachingProvider(inner);
    const { control } = createServices(p, testControlDeps());
    // Prime the caches with the pre-command state.
    await p.getDeviceStatus("lamp");
    await p.getDevice("lamp");
    const before = { status: calls.status, device: calls.device };

    const r = await control.turnOn({ actor: "t" }, "lamp");
    expect(r).toMatchObject({ status: "executed", verification: { result: "confirmed" } });
    expect(calls.device).toBeGreaterThan(before.device); // existence/online was read live
    expect(calls.status).toBeGreaterThan(before.status); // verification read live
  });

  it("does not let a cached 'online' flag hide that a device went offline", async () => {
    const fleet = smartFleet();
    const { inner } = counting(fleet);
    const p = new CachingProvider(inner);
    const { control } = createServices(p, testControlDeps());
    await p.getDevice("lamp"); // cached as online
    fleet.devices.find((d) => d.id === "lamp")!.online = false;
    await expect(control.turnOn({ actor: "t" }, "lamp")).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });
  });
});
