import { describe, expect, it, vi } from "vitest";
import type { DeviceCapability, DeviceStatus, SmartHomeDevice } from "@/core/domain";
import { AppError } from "@/core/errors";
import type { SmartHomeProvider } from "@/providers/provider.interface";
import { createServices } from "@/services/container";
import { MAX_STATUS_BATCH } from "@/services/status.service";

const device = (id: string, kind: SmartHomeDevice["category"]["kind"], online: boolean, code = kind as string): SmartHomeDevice => ({
  id,
  provider: "tuya",
  name: `Device ${id}`,
  category: { kind, providerCode: code },
  online,
  isSubDevice: false,
});

function fakeProvider(devices: SmartHomeDevice[], overrides: Partial<SmartHomeProvider> = {}): SmartHomeProvider {
  return {
    id: "tuya",
    checkConnection: async () => ({ provider: "tuya", connected: true }),
    listDevices: async () => devices,
    getDevice: async (id) => {
      const d = devices.find((x) => x.id === id);
      if (!d) throw new AppError("DEVICE_NOT_FOUND", "Device not found.");
      return d;
    },
    getDeviceStatus: async (id): Promise<DeviceStatus> => ({
      deviceId: id,
      online: true,
      properties: [],
      retrievedAt: "2026-11-15T00:00:00.000Z",
    }),
    getDeviceCapabilities: async (): Promise<DeviceCapability[]> => [],
    sendCommands: async () => {},
    ...overrides,
  };
}

const fleet = [
  device("a", "climate", true, "infrared_ac"),
  device("b", "remote", true, "wnykq"),
  device("c", "light", false, "dj"),
];

describe("DeviceService", () => {
  const { devices } = createServices(fakeProvider(fleet));

  it("lists everything without a filter", async () => {
    expect(await devices.listDevices()).toHaveLength(3);
  });

  it("filters by category kind or provider code (case-insensitive) and by online state", async () => {
    expect((await devices.listDevices({ category: "LIGHT" })).map((d) => d.id)).toEqual(["c"]);
    expect((await devices.listDevices({ category: "infrared_ac" })).map((d) => d.id)).toEqual(["a"]);
    expect((await devices.listDevices({ online: true })).map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("returns no devices for a room filter when the provider supplies no rooms (no guessing)", async () => {
    expect(await devices.listDevices({ room: "bedroom" })).toEqual([]);
  });

  it("validates device ids before calling the provider", async () => {
    const getDevice = vi.fn();
    const svc = createServices(fakeProvider(fleet, { getDevice })).devices;
    await expect(svc.getDevice("../x")).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    expect(getDevice).not.toHaveBeenCalled();
  });
});

describe("StatusService", () => {
  it("reports per-device results so one failure does not hide the others", async () => {
    const provider = fakeProvider(fleet, {
      getDeviceStatus: async (id) => {
        if (id === "b") throw new AppError("DEVICE_OFFLINE", "The device is offline.");
        if (id === "c") throw new Error("internal detail: secret=abc");
        return { deviceId: id, online: true, properties: [], retrievedAt: "t" };
      },
    });
    const results = await createServices(provider).status.getMultipleStatus(["a", "b", "c", "bad/id"]);
    expect(results.map((r) => [r.deviceId, r.ok])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
      ["bad/id", false],
    ]);
    const failures = results.filter((r) => !r.ok) as Array<{ error: { code: string } }>;
    expect(failures.map((f) => f.error.code)).toEqual(["DEVICE_OFFLINE", "INTERNAL_ERROR", "DEVICE_NOT_FOUND"]);
    expect(JSON.stringify(results)).not.toContain("secret=abc");
  });

  it("de-duplicates ids and caps the batch size", async () => {
    const getDeviceStatus = vi.fn(async (id: string) => ({ deviceId: id, online: true, properties: [], retrievedAt: "t" }));
    const svc = createServices(fakeProvider(fleet, { getDeviceStatus })).status;
    await svc.getMultipleStatus(["a", "a", "a"]);
    expect(getDeviceStatus).toHaveBeenCalledTimes(1);

    getDeviceStatus.mockClear();
    const many = Array.from({ length: MAX_STATUS_BATCH + 10 }, (_, i) => `d${i}`);
    expect(await svc.getMultipleStatus(many)).toHaveLength(MAX_STATUS_BATCH);
    expect(getDeviceStatus).toHaveBeenCalledTimes(MAX_STATUS_BATCH);
  });

  it("limits concurrent provider calls", async () => {
    let active = 0;
    let peak = 0;
    const getDeviceStatus = async (id: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { deviceId: id, online: true, properties: [], retrievedAt: "t" };
    };
    const svc = createServices(fakeProvider(fleet, { getDeviceStatus })).status;
    await svc.getMultipleStatus(Array.from({ length: 15 }, (_, i) => `d${i}`));
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("summarises the home from a single list call", async () => {
    const listDevices = vi.fn(async () => fleet);
    const overview = await createServices(fakeProvider(fleet, { listDevices })).status.getOverview();
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(overview).toMatchObject({
      total: 3,
      online: 2,
      offline: 1,
      byCategory: { climate: { total: 1, online: 1 }, remote: { total: 1, online: 1 }, light: { total: 1, online: 0 } },
    });
    expect(overview.devices).toHaveLength(3);
  });

  it("handles an empty home", async () => {
    const overview = await createServices(fakeProvider([])).status.getOverview();
    expect(overview).toEqual({ total: 0, online: 0, offline: 0, byCategory: {}, devices: [] });
  });
});

describe("CapabilityService", () => {
  it("validates the id and delegates to the provider", async () => {
    const getDeviceCapabilities = vi.fn(async () => []);
    const svc = createServices(fakeProvider(fleet, { getDeviceCapabilities })).capabilities;
    await svc.getCapabilities("a");
    expect(getDeviceCapabilities).toHaveBeenCalledWith("a");
    await expect(svc.getCapabilities("a/../b")).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });
});
