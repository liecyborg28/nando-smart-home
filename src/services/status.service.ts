import { parseDeviceId, type DeviceCategoryKind, type DeviceStatus } from "@/core/domain";
import { toSafeError, type SafeError } from "@/core/errors";
import type { SmartHomeProvider } from "@/providers/provider.interface";

export const MAX_STATUS_BATCH = 20;
const STATUS_CONCURRENCY = 5;

export type DeviceStatusResult =
  | { deviceId: string; ok: true; status: DeviceStatus }
  | { deviceId: string; ok: false; error: SafeError };

export interface SmartHomeOverview {
  total: number;
  online: number;
  offline: number;
  byCategory: Partial<Record<DeviceCategoryKind, { total: number; online: number }>>;
  devices: Array<{ id: string; name: string; category: string; online: boolean }>;
}

export class StatusService {
  constructor(private readonly provider: SmartHomeProvider) {}

  async getStatus(deviceId: string): Promise<DeviceStatus> {
    return this.provider.getDeviceStatus(parseDeviceId(deviceId));
  }

  /**
   * One failing device must not hide the rest, so each id gets its own result.
   * Ids are de-duplicated, capped, and fetched with bounded concurrency to
   * stay clear of the provider's rate limits.
   */
  async getMultipleStatus(deviceIds: string[]): Promise<DeviceStatusResult[]> {
    const ids = [...new Set(deviceIds)].slice(0, MAX_STATUS_BATCH);
    const results: DeviceStatusResult[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        const id = ids[i]!;
        try {
          results[i] = { deviceId: id, ok: true, status: await this.getStatus(id) };
        } catch (error) {
          results[i] = { deviceId: id, ok: false, error: toSafeError(error) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, ids.length) }, worker));
    return results;
  }

  /** Summary from the device list only (online flag per device): one provider call, no per-device fan-out. */
  async getOverview(): Promise<SmartHomeOverview> {
    const devices = await this.provider.listDevices();
    const byCategory: SmartHomeOverview["byCategory"] = {};
    let online = 0;
    for (const d of devices) {
      const entry = (byCategory[d.category.kind] ??= { total: 0, online: 0 });
      entry.total++;
      if (d.online) {
        entry.online++;
        online++;
      }
    }
    return {
      total: devices.length,
      online,
      offline: devices.length - online,
      byCategory,
      devices: devices.map((d) => ({ id: d.id, name: d.name, category: d.category.providerCode, online: d.online })),
    };
  }
}
