import type { CommandValue, DeviceCapability, DeviceCommandItem, DeviceStatus, SmartHomeDevice } from "@/core/domain";
import { AppError } from "@/core/errors";
import type { SmartHomeProvider } from "@/providers/provider.interface";

/**
 * A stateful fake smart home for evaluating the Agent Skills. It sits BEHIND the real
 * services and MCP tools, so an agent sees exactly the responses a real home would give,
 * while nothing physical is touched.
 */
export interface DeviceDef {
  id: string;
  name: string;
  kind: SmartHomeDevice["category"]["kind"];
  providerCode: string;
  online?: boolean;
  /** "none" = infrared style, results cannot be verified. */
  feedback?: "state" | "none";
  /** null = the device has no specification at all (an infrared hub). */
  caps: DeviceCapability[] | null;
  props?: Record<string, unknown>;
  /** The provider accepts commands but the device never changes (to exercise `mismatch`). */
  ignoreCommands?: boolean;
}

export interface SentCommand {
  deviceId: string;
  commands: DeviceCommandItem[];
}

export function createFakeHome(defs: DeviceDef[]) {
  const sent: SentCommand[] = [];
  const state = new Map(defs.map((d) => [d.id, { ...(d.props ?? {}) } as Record<string, unknown>]));
  const find = (id: string): DeviceDef => {
    const d = defs.find((x) => x.id === id);
    if (!d) throw new AppError("DEVICE_NOT_FOUND", "Device not found or not linked to this account.", { context: { providerCode: 1106 } });
    return d;
  };
  const toDevice = (d: DeviceDef): SmartHomeDevice => ({
    id: d.id,
    provider: "tuya",
    name: d.name,
    category: { kind: d.kind, providerCode: d.providerCode },
    online: d.online ?? true,
    isSubDevice: false,
    commandFeedback: d.feedback ?? "state",
  });

  const provider: SmartHomeProvider = {
    id: "tuya",
    checkConnection: async () => ({ provider: "tuya", connected: true }),
    listDevices: async () => defs.map(toDevice),
    getDevice: async (id) => toDevice(find(id)),
    getDeviceStatus: async (id): Promise<DeviceStatus> => {
      const d = find(id);
      return {
        deviceId: id,
        online: d.online ?? true,
        properties: Object.entries(state.get(id) ?? {}).map(([code, value]) => ({ code, value })),
        retrievedAt: new Date().toISOString(),
      };
    },
    getDeviceCapabilities: async (id) => {
      const d = find(id);
      if (d.caps === null) throw new AppError("UNSUPPORTED_OPERATION", "The device does not support this operation.", { context: { providerCode: 2009 } });
      return d.caps;
    },
    sendCommands: async (id, commands) => {
      const d = find(id);
      sent.push({ deviceId: id, commands });
      if (d.ignoreCommands) return;
      const props = state.get(id)!;
      for (const c of commands) {
        props[c.code] = c.value as CommandValue;
        // Infrared air conditioners remember the last key sent as their "power" state.
        if (c.code === "PowerOn") props.power = "1";
        if (c.code === "PowerOff") props.power = "0";
        if (c.code === "T") props.temp = String(c.value);
      }
    },
  };
  return { provider, sent };
}

export const cap = (
  code: string,
  kind: DeviceCapability["kind"],
  access: DeviceCapability["access"],
  constraints: DeviceCapability["constraints"] = {},
  name?: string,
): DeviceCapability => ({ code, kind, access, constraints, ...(name ? { name } : {}) });

/** Capabilities shaped like the real infrared air conditioner linked to the owner's account. */
export const irAcCaps = (): DeviceCapability[] => [
  cap("F", "enum", "write", { min: 0, max: 3, step: 1, scale: 0 }),
  cap("M", "enum", "write", { min: 0, max: 4, step: 1, scale: 0 }),
  cap("PowerOff", "string", "write", { raw: "PowerOff" }),
  cap("PowerOn", "string", "write", { raw: "PowerOn" }),
  cap("T", "enum", "write", { min: 16, max: 30, step: 1, scale: 0 }),
  cap("wind", "enum", "read", { min: 0, max: 3, step: 1, scale: 0 }),
  cap("mode", "enum", "read", { min: 0, max: 4, step: 1, scale: 0 }),
  cap("power", "boolean", "read"),
  cap("temp", "enum", "read", { min: 16, max: 30, step: 1, scale: 0 }),
];

export const lampCaps = (): DeviceCapability[] => [
  cap("switch_led", "boolean", "read-write"),
  cap("bright_value", "integer", "read-write", { min: 10, max: 1000, step: 1, scale: 0 }),
];
