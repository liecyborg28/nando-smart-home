import { parseDeviceId, type DeviceCapability } from "@/core/domain";
import { toSafeError, type SafeError } from "@/core/errors";
import type { SmartHomeProvider } from "@/providers/provider.interface";

export const MAX_CATALOG_DEVICES = 50;
const CATALOG_CONCURRENCY = 5;

export interface CapabilityCatalogEntry {
  deviceId: string;
  name: string;
  category: string;
  /** Empty when the device exposes none (see `error`). */
  capabilities: DeviceCapability[];
  /** Why capabilities are unavailable, e.g. UNSUPPORTED_OPERATION for IR hubs. */
  error?: SafeError;
}

export class CapabilityService {
  constructor(private readonly provider: SmartHomeProvider) {}

  /** Capabilities come from the device's own specification, never from assumptions about its type. */
  async getCapabilities(deviceId: string): Promise<DeviceCapability[]> {
    return this.provider.getDeviceCapabilities(parseDeviceId(deviceId));
  }

  /**
   * Capabilities of every device, one entry each. A device that fails (or has no
   * specification) gets an `error` instead of hiding the rest. Bounded in size
   * and concurrency to respect provider rate limits.
   */
  async getCatalog(): Promise<{ entries: CapabilityCatalogEntry[]; truncated: boolean }> {
    const all = await this.provider.listDevices();
    const devices = all.slice(0, MAX_CATALOG_DEVICES);
    const entries: CapabilityCatalogEntry[] = new Array(devices.length);
    let next = 0;
    const worker = async () => {
      while (next < devices.length) {
        const i = next++;
        const d = devices[i]!;
        const base = { deviceId: d.id, name: d.name, category: d.category.providerCode };
        try {
          entries[i] = { ...base, capabilities: await this.provider.getDeviceCapabilities(d.id) };
        } catch (error) {
          entries[i] = { ...base, capabilities: [], error: toSafeError(error) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CATALOG_CONCURRENCY, devices.length) }, worker));
    return { entries, truncated: all.length > devices.length };
  }
}
