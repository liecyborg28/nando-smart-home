import type { DeviceCommandItem, DeviceStatus } from "@/core/domain";

/**
 * Result verification. A provider answering "accepted" only means the request was
 * received; we read the device state back and compare it with what we asked for.
 *
 *  confirmed         every command's property now has the requested value
 *  partially_verified some confirmed, others have no matching status property
 *  mismatch          at least one property reports a different value
 *  not_verifiable    nothing could be compared (no feedback, or no matching status property)
 */
export type VerificationResult = "confirmed" | "partially_verified" | "mismatch" | "not_verifiable";

export interface VerificationDetail {
  code: string;
  expected: string | number | boolean;
  actual?: unknown;
  outcome: "confirmed" | "mismatch" | "not_verifiable";
}

export interface Verification {
  result: VerificationResult;
  details: VerificationDetail[];
  note?: string;
}

const norm = (v: unknown): string => String(v).trim().toLowerCase();

/** Tuya-style status values are sometimes strings ("1", "true") for booleans; compare tolerantly. */
export function sameValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "boolean") {
    const a = norm(actual);
    return expected ? a === "true" || a === "1" || a === "on" : a === "false" || a === "0" || a === "off";
  }
  return norm(expected) === norm(actual);
}

export function verifyCommands(commands: DeviceCommandItem[], after: DeviceStatus): Verification {
  const details: VerificationDetail[] = commands.map((c) => {
    const prop = after.properties.find((p) => p.code === c.code);
    if (!prop) return { code: c.code, expected: c.value, outcome: "not_verifiable" };
    return { code: c.code, expected: c.value, actual: prop.value, outcome: sameValue(c.value, prop.value) ? "confirmed" : "mismatch" };
  });
  const confirmed = details.filter((d) => d.outcome === "confirmed").length;
  const mismatched = details.some((d) => d.outcome === "mismatch");
  const result: VerificationResult = mismatched
    ? "mismatch"
    : confirmed === details.length
      ? "confirmed"
      : confirmed > 0
        ? "partially_verified"
        : "not_verifiable";
  return { result, details };
}

export const NO_FEEDBACK_NOTE =
  "This device gives no state feedback (for example infrared control), so the result cannot be verified. " +
  "The provider accepted the command, but whether the device acted on it is unknown.";
