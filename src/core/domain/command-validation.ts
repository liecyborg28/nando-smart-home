import { AppError } from "@/core/errors";
import { MAX_COMMANDS_PER_CALL, type CommandValue, type DeviceCapability, type DeviceCommandItem } from "./index";

/**
 * Command validation against the device's OWN capabilities. Commands are never
 * accepted on the strength of a device type: a code must be a writable capability
 * of this device and the value must satisfy that capability's kind and constraints.
 *
 * Error choice: a code the device does not offer (or only reports) is
 * UNSUPPORTED_OPERATION; a value that does not fit a real capability is
 * INVALID_DEVICE_COMMAND.
 */

export const COMMAND_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_STRING_VALUE = 255;

function invalid(code: string, message: string): AppError {
  return new AppError("INVALID_DEVICE_COMMAND", message, { context: { code } });
}

function describeRange(c: DeviceCapability["constraints"]): string {
  const parts: string[] = [];
  if (c.min !== undefined || c.max !== undefined) parts.push(`between ${c.min ?? "-inf"} and ${c.max ?? "+inf"}`);
  if (c.step !== undefined && c.step > 1) parts.push(`in steps of ${c.step}`);
  return parts.join(" ");
}

function validateNumber(code: string, value: CommandValue, c: DeviceCapability["constraints"]): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(code, `Value for "${code}" must be a whole number.`);
  }
  if ((c.min !== undefined && value < c.min) || (c.max !== undefined && value > c.max)) {
    throw invalid(code, `Value for "${code}" must be ${describeRange(c)}.`);
  }
  if (c.step !== undefined && c.step > 0 && (value - (c.min ?? 0)) % c.step !== 0) {
    throw invalid(code, `Value for "${code}" must be ${describeRange(c)}.`);
  }
}

function validateValue(cap: DeviceCapability, value: CommandValue): void {
  const { code, constraints: c } = cap;
  switch (cap.kind) {
    case "boolean":
      if (typeof value !== "boolean") throw invalid(code, `Value for "${code}" must be true or false.`);
      return;
    case "integer":
      validateNumber(code, value, c);
      return;
    case "enum":
      if (c.range && c.range.length > 0) {
        if (typeof value !== "string" || !c.range.includes(value)) {
          throw invalid(code, `Value for "${code}" must be one of: ${c.range.join(", ")}.`);
        }
        return;
      }
      // Some devices (observed on infrared air conditioners) declare ENUM but describe a numeric range.
      if (c.min !== undefined || c.max !== undefined) {
        validateNumber(code, value, c);
        return;
      }
      if (typeof value !== "string" || !COMMAND_CODE_PATTERN.test(value)) {
        throw invalid(code, `Value for "${code}" must be a short text value.`);
      }
      return;
    case "string":
      if (typeof value !== "string" || value.length > MAX_STRING_VALUE) {
        throw invalid(code, `Value for "${code}" must be text of at most ${MAX_STRING_VALUE} characters.`);
      }
      // A capability whose only declared value is a fixed string (e.g. an IR "PowerOn" key) accepts exactly that.
      if (c.raw !== undefined && value !== c.raw) {
        throw invalid(code, `Value for "${code}" must be exactly "${c.raw}".`);
      }
      return;
    default:
      // json / raw / bitmap / unknown: no safe generic validation exists, so refuse rather than guess.
      throw new AppError("UNSUPPORTED_OPERATION", `Capability "${code}" has a type (${cap.kind}) that cannot be controlled through this interface.`, {
        context: { code },
      });
  }
}

export function validateCommands(capabilities: DeviceCapability[], commands: DeviceCommandItem[]): void {
  if (commands.length === 0 || commands.length > MAX_COMMANDS_PER_CALL) {
    throw new AppError("INVALID_DEVICE_COMMAND", `Send between 1 and ${MAX_COMMANDS_PER_CALL} commands per call.`);
  }
  const seen = new Set<string>();
  for (const command of commands) {
    if (!COMMAND_CODE_PATTERN.test(command.code)) {
      throw new AppError("INVALID_DEVICE_COMMAND", "Command code has an invalid format.");
    }
    if (seen.has(command.code)) {
      throw invalid(command.code, `Command "${command.code}" appears more than once.`);
    }
    seen.add(command.code);

    const cap = capabilities.find((x) => x.code === command.code);
    if (!cap) {
      throw new AppError("UNSUPPORTED_OPERATION", `This device has no capability "${command.code}".`, { context: { code: command.code } });
    }
    if (cap.access === "read") {
      throw new AppError("UNSUPPORTED_OPERATION", `Capability "${command.code}" is read-only.`, { context: { code: command.code } });
    }
    validateValue(cap, command.value);
  }
}
