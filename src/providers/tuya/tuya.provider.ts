import type { DeviceCapability, DeviceCommandItem, DeviceStatus, SmartHomeDevice } from "@/core/domain";
import { parseDeviceId } from "@/core/domain";
import type { ProviderConnectionStatus, SmartHomeProvider } from "@/providers/provider.interface";
import type { TuyaClient } from "./tuya.client";
import { TuyaDeviceApi } from "./tuya.devices";
import { mapCapabilities, mapDevice, mapStatus } from "./tuya.mapper";

/** Tuya implementation of the provider contract. Only this layer knows Tuya shapes. */
export class TuyaProvider implements SmartHomeProvider {
  readonly id = "tuya" as const;
  private readonly api: TuyaDeviceApi;

  constructor(
    private readonly client: TuyaClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.api = new TuyaDeviceApi(client);
  }

  async checkConnection(): Promise<ProviderConnectionStatus> {
    await this.client.verifyConnection();
    return { provider: "tuya", connected: true };
  }

  async listDevices(): Promise<SmartHomeDevice[]> {
    return (await this.api.listDevices()).map(mapDevice);
  }

  async getDevice(deviceId: string): Promise<SmartHomeDevice> {
    return mapDevice(await this.api.getDevice(parseDeviceId(deviceId)));
  }

  async getDeviceStatus(deviceId: string): Promise<DeviceStatus> {
    const id = parseDeviceId(deviceId);
    const device = await this.api.getDevice(id); // existence + online flag
    return mapStatus(device, this.now(), await this.api.getStatusItems(id, device.status));
  }

  async getDeviceCapabilities(deviceId: string): Promise<DeviceCapability[]> {
    return mapCapabilities(await this.api.getSpecifications(parseDeviceId(deviceId)));
  }

  async sendCommands(deviceId: string, commands: DeviceCommandItem[]): Promise<void> {
    await this.api.sendCommands(parseDeviceId(deviceId), commands);
  }
}
