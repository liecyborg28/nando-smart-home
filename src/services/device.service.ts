import { parseDeviceId, type DeviceFilter, type SmartHomeDevice } from "@/core/domain";
import type { SmartHomeProvider } from "@/providers/provider.interface";

export class DeviceService {
  constructor(private readonly provider: SmartHomeProvider) {}

  /**
   * Filters are applied here (not per provider) so REST and MCP behave the same.
   * `room` only matches devices that carry room data; Tuya's device list does
   * not supply rooms, so it returns nothing rather than guessing.
   */
  async listDevices(filter: DeviceFilter = {}): Promise<SmartHomeDevice[]> {
    const devices = await this.provider.listDevices();
    const category = filter.category?.toLowerCase();
    const room = filter.room?.toLowerCase();
    return devices.filter((d) => {
      if (category && d.category.kind !== category && d.category.providerCode.toLowerCase() !== category) return false;
      if (room && d.room?.name.toLowerCase() !== room && d.room?.id.toLowerCase() !== room) return false;
      if (filter.online !== undefined && d.online !== filter.online) return false;
      return true;
    });
  }

  async getDevice(deviceId: string): Promise<SmartHomeDevice> {
    return this.provider.getDevice(parseDeviceId(deviceId));
  }
}
