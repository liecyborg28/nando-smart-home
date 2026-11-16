import type { CommandValue, DeviceCapability, DeviceCommandItem, DeviceStatus, SmartHomeDevice } from "@/core/domain";
import { AppError } from "@/core/errors";
import type { SmartHomeProvider } from "@/providers/provider.interface";
import { ConfirmationManager, createConfirmationPolicy } from "@/security/confirmation";
import type { ControlDeps } from "@/services/control.service";

/** Test control deps: instant verification (no real sleeping) and a fixed signing secret. */
export function testControlDeps(overrides: Partial<ControlDeps> = {}, now: () => number = Date.now): ControlDeps {
  return {
    confirmations: new ConfirmationManager("test-confirmation-secret-0123456789", now),
    policy: createConfirmationPolicy({ categories: ["ms"], confirmAll: false }),
    sleep: async () => {},
    verifyDelaysMs: [0, 0],
    ...overrides,
  };
}

const dev = (id: string, name: string, kind: SmartHomeDevice["category"]["kind"], providerCode: string, online = true, commandFeedback: "state" | "none" = "state"): SmartHomeDevice => ({
  id,
  provider: "tuya",
  name,
  category: { kind, providerCode },
  online,
  isSubDevice: false,
  commandFeedback,
});

const cap = (code: string, kind: DeviceCapability["kind"], access: DeviceCapability["access"], constraints: DeviceCapability["constraints"] = {}): DeviceCapability => ({ code, kind, access, constraints });

/**
 * A stateful fake provider modelled on real Tuya device shapes:
 *  lamp     standard device: boolean switch + integer brightness, state is read back
 *  lamp2    same shape, offline
 *  ir-ac    infrared air conditioner: fixed-value PowerOn/PowerOff keys, one-way (no feedback)
 *  door     category "ms" (door lock): high impact, needs confirmation
 *  sensor   read-only temperature sensor
 *  multi    two switches (ambiguous power)
 */
export function smartFleet(options: { ignoreCommands?: boolean } = {}) {
  const devices = [
    dev("lamp", "Desk lamp", "light", "dj"),
    dev("lamp2", "Offline lamp", "light", "dj", false),
    dev("ir-ac", "Living room AC", "climate", "infrared_ac", true, "none"),
    dev("door", "Front door", "other", "ms"),
    dev("sensor", "Hallway sensor", "sensor", "wsdcg"),
    dev("multi", "Power strip", "socket", "cz"),
  ];

  const caps: Record<string, DeviceCapability[]> = {
    lamp: [cap("switch_led", "boolean", "read-write"), cap("bright_value", "integer", "read-write", { min: 10, max: 1000, step: 1 })],
    lamp2: [cap("switch_led", "boolean", "read-write")],
    "ir-ac": [
      cap("PowerOn", "string", "write", { raw: "PowerOn" }),
      cap("PowerOff", "string", "write", { raw: "PowerOff" }),
      cap("T", "enum", "write", { min: 16, max: 30, step: 1 }),
      cap("power", "boolean", "read"),
    ],
    door: [cap("lock_motor_state", "boolean", "read-write")],
    sensor: [cap("va_temperature", "integer", "read", { min: -400, max: 1250 })],
    multi: [cap("switch_1", "boolean", "read-write"), cap("switch", "boolean", "read-write")],
  };

  const props: Record<string, Record<string, unknown>> = {
    lamp: { switch_led: false, bright_value: 100 },
    lamp2: { switch_led: false },
    "ir-ac": { power: "0" },
    door: { lock_motor_state: true },
    sensor: { va_temperature: 215 },
    multi: { switch_1: false, switch: false },
  };

  const sent: Array<{ deviceId: string; commands: DeviceCommandItem[] }> = [];
  const find = (id: string) => {
    const d = devices.find((x) => x.id === id);
    if (!d) throw new AppError("DEVICE_NOT_FOUND", "Device not found.");
    return d;
  };

  const provider: SmartHomeProvider = {
    id: "tuya",
    checkConnection: async () => ({ provider: "tuya", connected: true }),
    listDevices: async () => devices,
    getDevice: async (id) => find(id),
    getDeviceStatus: async (id): Promise<DeviceStatus> => ({
      deviceId: id,
      online: find(id).online,
      properties: Object.entries(props[id] ?? {}).map(([code, value]) => ({ code, value })),
      retrievedAt: "2026-11-15T00:00:00.000Z",
    }),
    getDeviceCapabilities: async (id) => {
      find(id);
      return caps[id] ?? [];
    },
    sendCommands: async (id, commands) => {
      find(id);
      sent.push({ deviceId: id, commands });
      if (options.ignoreCommands) return; // accepted by the provider but the device did not change
      for (const c of commands) (props[id] ??= {})[c.code] = c.value as CommandValue;
    },
  };

  return { provider, sent, props, devices };
}
