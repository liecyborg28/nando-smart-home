import type { DeviceCapability, DeviceCommandItem, DeviceStatus, SmartHomeDevice } from "@/core/domain";
import { TtlCache } from "@/lib/ttl-cache";
import type { ProviderConnectionStatus, ReadOptions, SmartHomeProvider } from "./provider.interface";

export interface CacheTtls {
  listMs: number;
  deviceMs: number;
  statusMs: number;
  capabilitiesMs: number;
}

export const DEFAULT_CACHE_TTLS: CacheTtls = { listMs: 15_000, deviceMs: 15_000, statusMs: 3_000, capabilitiesMs: 10 * 60_000 };

/**
 * Wraps any provider with short-lived caching and de-duplication of concurrent reads.
 *
 * Why: every cloud call spends the provider's API quota and adds latency, and a single tool
 * call can fan out into dozens of them (batch status, the capability catalog). Caching bounds
 * how much quota any one client can burn. Writes invalidate what they could have changed, and
 * `fresh: true` reads (used by control and verification) always go to the provider.
 */
export class CachingProvider implements SmartHomeProvider {
  readonly id;
  private readonly list: TtlCache<SmartHomeDevice[]>;
  private readonly devices: TtlCache<SmartHomeDevice>;
  private readonly statuses: TtlCache<DeviceStatus>;
  private readonly capabilities: TtlCache<DeviceCapability[]>;

  constructor(
    private readonly inner: SmartHomeProvider,
    ttls: CacheTtls = DEFAULT_CACHE_TTLS,
    now: () => number = Date.now,
  ) {
    this.id = inner.id;
    this.list = new TtlCache(ttls.listMs, now, 4);
    this.devices = new TtlCache(ttls.deviceMs, now);
    this.statuses = new TtlCache(ttls.statusMs, now);
    this.capabilities = new TtlCache(ttls.capabilitiesMs, now);
  }

  checkConnection(): Promise<ProviderConnectionStatus> {
    return this.inner.checkConnection(); // a health probe must always be live
  }

  listDevices(options?: ReadOptions): Promise<SmartHomeDevice[]> {
    return this.list.get("all", () => this.inner.listDevices(options), cacheOpts(options));
  }

  getDevice(deviceId: string, options?: ReadOptions): Promise<SmartHomeDevice> {
    return this.devices.get(deviceId, () => this.inner.getDevice(deviceId, options), cacheOpts(options));
  }

  getDeviceStatus(deviceId: string, options?: ReadOptions): Promise<DeviceStatus> {
    return this.statuses.get(deviceId, () => this.inner.getDeviceStatus(deviceId, options), cacheOpts(options));
  }

  getDeviceCapabilities(deviceId: string): Promise<DeviceCapability[]> {
    return this.capabilities.get(deviceId, () => this.inner.getDeviceCapabilities(deviceId));
  }

  async sendCommands(deviceId: string, commands: DeviceCommandItem[]): Promise<void> {
    try {
      await this.inner.sendCommands(deviceId, commands);
    } finally {
      // Even a failed write may have partly applied: never serve pre-write state afterwards.
      this.devices.delete(deviceId);
      this.statuses.delete(deviceId);
      this.list.clear();
    }
  }
}

const cacheOpts = (o?: ReadOptions) => ({ fresh: o?.fresh === true });
