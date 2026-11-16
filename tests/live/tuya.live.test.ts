import { describe, expect, it } from "vitest";
import { parseEnv, tuyaConfigFrom } from "@/config/env";
import { AppError } from "@/core/errors";
import { TuyaClient } from "@/providers/tuya/tuya.client";
import { TuyaProvider } from "@/providers/tuya/tuya.provider";
import { createServices } from "@/services/container";

/**
 * LIVE tests: real, READ-ONLY calls against Tuya Cloud (no commands are sent).
 * Not part of `npm test`. Run explicitly with `npm run test:live`.
 * Reads credentials from .env. Logs only counts, never names, ids or secrets.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: the tests below report that credentials are missing.
}

function live() {
  const config = tuyaConfigFrom(parseEnv(process.env));
  expect(config, "TUYA_ACCESS_ID / TUYA_ACCESS_SECRET must be set in .env").toBeDefined();
  const provider = new TuyaProvider(new TuyaClient(config!));
  return { provider, services: createServices(provider) };
}

describe("Tuya live connection", () => {
  it("authenticates against the configured data center", async () => {
    const config = tuyaConfigFrom(parseEnv(process.env));
    expect(config, "TUYA_ACCESS_ID / TUYA_ACCESS_SECRET must be set in .env").toBeDefined();
    const result = await new TuyaClient(config!).verifyConnection();
    expect(result.connected).toBe(true);
    expect(result.tokenValidForSeconds).toBeGreaterThan(0);
  });
});

describe("Tuya live device reads (read-only)", () => {
  it("lists devices through the service layer without sensitive fields", async () => {
    const { services } = live();
    const devices = await services.devices.listDevices();
    console.log(`live: ${devices.length} device(s) linked`);
    expect(devices.length).toBeGreaterThan(0);
    for (const d of devices) {
      expect(d.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(typeof d.online).toBe("boolean");
    }
    const json = JSON.stringify(devices);
    for (const key of ["local_key", "\"ip\"", "\"uid\"", "owner_id", "\"lat\"", "\"lon\""]) {
      expect(json).not.toContain(key);
    }
  });

  it("reads detail, status and capabilities for every device (capabilities may be unsupported)", async () => {
    const { services } = live();
    const devices = await services.devices.listDevices();
    let withCaps = 0;
    let unsupported = 0;
    for (const d of devices) {
      expect((await services.devices.getDevice(d.id)).id).toBe(d.id);
      const status = await services.status.getStatus(d.id);
      expect(status.deviceId).toBe(d.id);
      expect(Array.isArray(status.properties)).toBe(true);
      try {
        const caps = await services.capabilities.getCapabilities(d.id);
        expect(Array.isArray(caps)).toBe(true);
        withCaps++;
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("UNSUPPORTED_OPERATION");
        unsupported++;
      }
    }
    console.log(`live: capabilities available for ${withCaps}, unsupported for ${unsupported}`);
  });

  it("returns a batch of statuses and an overview", async () => {
    const { services } = live();
    const devices = await services.devices.listDevices();
    const results = await services.status.getMultipleStatus(devices.map((d) => d.id));
    expect(results.every((r) => r.ok)).toBe(true);
    const overview = await services.status.getOverview();
    expect(overview.total).toBe(devices.length);
    expect(overview.online + overview.offline).toBe(overview.total);
  });

  it("reports an unknown device id as DEVICE_NOT_FOUND", async () => {
    const { services } = live();
    await expect(services.devices.getDevice("does-not-exist-123")).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });
});
