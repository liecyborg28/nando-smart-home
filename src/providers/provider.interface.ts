import type { DeviceCapability, DeviceCommandItem, DeviceStatus, ProviderId, SmartHomeDevice } from "@/core/domain";

/** `fresh: true` bypasses any caching layer; control and verification must read live state. */
export interface ReadOptions {
  fresh?: boolean;
}

export interface ProviderConnectionStatus {
  provider: ProviderId;
  connected: boolean;
}

/**
 * Contract every smart-home provider implements. Services, REST and MCP depend
 * only on this interface; provider-specific details stay behind it.
 * Commands are validated against capabilities BEFORE they reach a provider.
 */
export interface SmartHomeProvider {
  readonly id: ProviderId;
  checkConnection(): Promise<ProviderConnectionStatus>;
  listDevices(options?: ReadOptions): Promise<SmartHomeDevice[]>;
  getDevice(deviceId: string, options?: ReadOptions): Promise<SmartHomeDevice>;
  getDeviceStatus(deviceId: string, options?: ReadOptions): Promise<DeviceStatus>;
  getDeviceCapabilities(deviceId: string): Promise<DeviceCapability[]>;
  /** Sends already-validated commands. Resolves once the provider has ACCEPTED them (not that the device acted). */
  sendCommands(deviceId: string, commands: DeviceCommandItem[]): Promise<void>;
}
