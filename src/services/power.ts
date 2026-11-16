import type { DeviceCapability, DeviceCommandItem } from "@/core/domain";
import { AppError } from "@/core/errors";

/**
 * Turns "turn on/off" into a concrete command built from the device's real
 * capabilities. The code lists below only IDENTIFY which of the device's own
 * writable capabilities is its power switch; a device without such a
 * capability is refused, never sent a guessed command.
 */

const SWITCH_CODES = new Set(["switch", "switch_1", "switch_led", "power"]);

const writable = (c: DeviceCapability) => c.access === "write" || c.access === "read-write";

export function resolvePowerCommand(capabilities: DeviceCapability[], on: boolean): DeviceCommandItem {
  const switches = capabilities.filter((c) => writable(c) && c.kind === "boolean" && SWITCH_CODES.has(c.code));
  if (switches.length === 1) return { code: switches[0]!.code, value: on };
  if (switches.length > 1) {
    throw new AppError("INVALID_DEVICE_COMMAND", "This device has several power switches. Use set_device_property with the specific switch code.", {
      context: { candidates: switches.map((s) => s.code).join(",") },
    });
  }

  // Infrared-style pair of fixed-value keys: PowerOn / PowerOff.
  const key = on ? "PowerOn" : "PowerOff";
  const ir = capabilities.find((c) => writable(c) && c.kind === "string" && c.code === key && c.constraints.raw === key);
  if (ir) return { code: key, value: key };

  throw new AppError(
    "UNSUPPORTED_OPERATION",
    "This device has no recognizable power control. Inspect get_device_capabilities and use set_device_property or execute_device_command.",
  );
}
