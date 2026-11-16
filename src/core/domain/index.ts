/**
 * Provider-independent domain models. This layer must not import Tuya, MCP or
 * Next.js code. Free-text fields (names, string values) come from the provider
 * and are UNTRUSTED: consumers must treat them as data, never as instructions.
 */
import { z } from "zod";
import { AppError } from "@/core/errors";

export type ProviderId = "tuya";

export type DeviceCategoryKind =
  | "switch"
  | "socket"
  | "light"
  | "climate"
  | "sensor"
  | "curtain"
  | "camera"
  | "remote"
  | "other";

/** `kind` is a coarse grouping for filtering/summaries only. Never derive supported commands from it. */
export interface DeviceCategory {
  kind: DeviceCategoryKind;
  /** The provider's own category code, e.g. Tuya "infrared_ac". */
  providerCode: string;
}

/** Rooms are not supplied by every provider/endpoint; devices may have none. */
export interface DeviceRoom {
  id: string;
  name: string;
}

export interface SmartHomeDevice {
  id: string;
  provider: ProviderId;
  name: string;
  category: DeviceCategory;
  online: boolean;
  productName?: string;
  isSubDevice: boolean;
  room?: DeviceRoom;
  /**
   * Whether the device reports real state back after a command.
   * "none" (e.g. infrared-controlled devices) means command results cannot be verified from status.
   * Undefined is treated as "state".
   */
  commandFeedback?: "state" | "none";
}

export type CapabilityKind = "boolean" | "enum" | "integer" | "string" | "json" | "raw" | "bitmap" | "unknown";
export type CapabilityAccess = "read" | "write" | "read-write";

export interface CapabilityConstraints {
  min?: number;
  max?: number;
  step?: number;
  scale?: number;
  unit?: string;
  /** Allowed values for enum-like capabilities. */
  range?: string[];
  /** Provider value that did not parse as structured constraints (kept short, as data). */
  raw?: string;
}

export interface DeviceCapability {
  code: string;
  kind: CapabilityKind;
  access: CapabilityAccess;
  constraints: CapabilityConstraints;
  name?: string;
}

export interface DeviceProperty {
  code: string;
  value: unknown;
}

export interface DeviceStatus {
  deviceId: string;
  online: boolean;
  properties: DeviceProperty[];
  /** ISO-8601 time at which this status was read from the provider. */
  retrievedAt: string;
}

export interface DeviceFilter {
  category?: DeviceCategoryKind | string;
  room?: string;
  online?: boolean;
}

/** Device ids end up in provider URL paths, so only a conservative character set is accepted. */
export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid device id");

export function parseDeviceId(input: unknown): string {
  const parsed = deviceIdSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("DEVICE_NOT_FOUND", "Invalid device id.", { context: { field: "deviceId" } });
  }
  return parsed.data;
}

export type CommandValue = string | number | boolean;

/** One instruction for a device, expressed in the device's own capability codes. */
export interface DeviceCommandItem {
  code: string;
  value: CommandValue;
}

export const MAX_COMMANDS_PER_CALL = 10;
