import { z } from "zod";
import type { DeviceCommandItem } from "@/core/domain";
import { AppError } from "@/core/errors";
import type { TuyaClient } from "./tuya.client";
import {
  rawDeviceListSchema,
  rawDeviceSchema,
  rawSpecSchema,
  rawStatusItemSchema,
  type RawDevice,
  type RawSpec,
  type RawStatusItem,
} from "./tuya.types";

/**
 * Raw Tuya device endpoints. Verified live against a Smart Life account:
 *  - list:   GET /v1.0/iot-01/associated-users/devices (size, last_row_key, has_more)
 *            (GET /v1.0/devices answered Tuya code 1100 for this project)
 *  - detail: GET /v1.0/devices/{id}  (existence + online flag; its embedded `status` is EMPTY for
 *            infrared virtual devices, so it is only a fallback)
 *  - status: GET /v1.0/devices/{id}/status  (the real property list; rejected for some device
 *            types, e.g. the IR hub answers code 2003)
 *  - specs:  GET /v1.0/devices/{id}/specifications
 */

const PAGE_SIZE = 20;
const MAX_PAGES = 50; // hard stop: 1000 devices, guards against a provider that never ends pagination

function malformed(): AppError {
  return new AppError("PROVIDER_UNAVAILABLE", "Tuya returned an unexpected device response.");
}

/**
 * For device-scoped calls Tuya answers 1106 ("permission deny") when the id is
 * not linked to this account. Surface that as DEVICE_NOT_FOUND so callers get a
 * stable code and cannot tell "someone else's device" from "no such device".
 */
function asDeviceScoped(error: unknown): never {
  if (error instanceof AppError && error.code === "AUTHORIZATION_FAILED" && error.context?.providerCode === 1106) {
    throw new AppError("DEVICE_NOT_FOUND", "Device not found or not linked to this account.", {
      context: { providerCode: 1106 },
    });
  }
  throw error;
}

export class TuyaDeviceApi {
  constructor(private readonly client: TuyaClient) {}

  async listDevices(): Promise<RawDevice[]> {
    const devices: RawDevice[] = [];
    let lastRowKey: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.client.request<unknown>({
        method: "GET",
        path: "/v1.0/iot-01/associated-users/devices",
        query: { size: PAGE_SIZE, last_row_key: lastRowKey },
      });
      const parsed = rawDeviceListSchema.safeParse(result);
      if (!parsed.success) throw malformed();
      for (const item of parsed.data.devices) {
        const device = rawDeviceSchema.safeParse(item);
        // Skip a single malformed entry rather than failing the whole listing.
        if (device.success) devices.push(device.data);
      }
      if (!parsed.data.has_more || !parsed.data.last_row_key) return devices;
      lastRowKey = parsed.data.last_row_key;
    }
    return devices;
  }

  async getDevice(deviceId: string): Promise<RawDevice> {
    try {
      const result = await this.client.request<unknown>({ method: "GET", path: `/v1.0/devices/${deviceId}` });
      const parsed = rawDeviceSchema.safeParse(result);
      if (!parsed.success) throw malformed();
      return parsed.data;
    } catch (error) {
      return asDeviceScoped(error);
    }
  }

  /**
   * Status properties. Prefers the dedicated /status endpoint; falls back to the
   * status embedded in the device detail ONLY when Tuya says the device does not
   * support that endpoint. Rate limits, timeouts, token and permission errors are
   * real failures and are not hidden by the fallback.
   */
  async getStatusItems(deviceId: string, fallback: RawStatusItem[]): Promise<RawStatusItem[]> {
    try {
      const result = await this.client.request<unknown>({ method: "GET", path: `/v1.0/devices/${deviceId}/status` });
      const parsed = z.array(rawStatusItemSchema).safeParse(result);
      if (!parsed.success) throw malformed();
      return parsed.data;
    } catch (error) {
      const unsupported =
        error instanceof AppError &&
        (error.code === "UNSUPPORTED_OPERATION" || (error.code === "PROVIDER_UNAVAILABLE" && typeof error.context?.providerCode === "number"));
      if (unsupported) return fallback;
      return asDeviceScoped(error);
    }
  }

  async getSpecifications(deviceId: string): Promise<RawSpec> {
    try {
      const result = await this.client.request<unknown>({
        method: "GET",
        path: `/v1.0/devices/${deviceId}/specifications`,
      });
      const parsed = rawSpecSchema.safeParse(result);
      if (!parsed.success) throw malformed();
      return parsed.data;
    } catch (error) {
      return asDeviceScoped(error);
    }
  }

  /**
   * POST /v1.0/devices/{id}/commands with {"commands":[{code,value}]} (current Tuya docs).
   * `result: true` only says the request was accepted; callers must verify state separately.
   */
  async sendCommands(deviceId: string, commands: DeviceCommandItem[]): Promise<void> {
    let result: unknown;
    try {
      result = await this.client.request<unknown>({
        method: "POST",
        path: `/v1.0/devices/${deviceId}/commands`,
        body: { commands: commands.map((c) => ({ code: c.code, value: c.value })) },
      });
    } catch (error) {
      return asDeviceScoped(error);
    }
    if (result !== true) {
      throw new AppError("INVALID_DEVICE_COMMAND", "The provider did not accept the command.");
    }
  }
}
