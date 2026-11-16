import type {
  CapabilityAccess,
  CapabilityConstraints,
  CapabilityKind,
  DeviceCapability,
  DeviceCategoryKind,
  DeviceStatus,
  SmartHomeDevice,
} from "@/core/domain";
import { COMMAND_CODE_PATTERN } from "@/core/domain/command-validation";
import type { RawDevice, RawSpec, RawSpecItem, RawStatusItem } from "./tuya.types";

/**
 * Pure mapping from Tuya payloads to provider-independent domain models.
 * Field selection is an allowlist: anything not copied here (local_key, ip,
 * uid, coordinates...) cannot reach the domain, MCP or REST layers.
 */

const NAME_MAX = 100;

/**
 * Device names are user/provider-controlled text and may carry prompt-injection
 * payloads. We cannot make them "safe" by filtering, but we strip control
 * characters and cap length so they stay inert, single-line data.
 */
export function sanitizeText(input: string, max = NAME_MAX): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

const MAX_VALUE_STRING = 200;
const MAX_PROPERTIES = 100;
const MAX_CAPABILITIES = 200;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 4;

/**
 * Property values come straight from the provider (and, for strings, can be set by anyone able to
 * name or configure a device), so they are untrusted. Reduce them to plain, bounded JSON: strings
 * are cleaned and capped, nesting and size are limited, and anything that is not plain data
 * (functions, bigint, non-finite numbers) becomes null. This keeps a hostile value from being
 * huge or from carrying hidden control characters into an agent's context.
 */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return sanitizeText(value, MAX_VALUE_STRING);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "object": {
      if (depth >= MAX_DEPTH) return "[truncated]";
      if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeValue(v, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
        if (COMMAND_CODE_PATTERN.test(k)) out[k] = sanitizeValue(v, depth + 1);
      }
      return out;
    }
    default:
      return null;
  }
}

// Coarse grouping for filters and summaries. Best-effort: unknown codes become "other"
// and the provider's own code is always preserved. Never infer commands from this.
const CATEGORY_KIND: Record<string, DeviceCategoryKind> = {
  kg: "switch",
  tdq: "switch",
  cz: "socket",
  pc: "socket",
  dj: "light",
  dd: "light",
  xdd: "light",
  fwd: "light",
  kt: "climate",
  infrared_ac: "climate",
  wsdcg: "sensor",
  mcs: "sensor",
  pir: "sensor",
  cl: "curtain",
  clkg: "curtain",
  sp: "camera",
  wnykq: "remote",
  hjjcy: "sensor",
};

export function mapCategory(code: string): { kind: DeviceCategoryKind; providerCode: string } {
  return { kind: CATEGORY_KIND[code] ?? "other", providerCode: code };
}

/** Infrared-controlled devices (virtual IR remotes and their hubs) are one-way: Tuya cannot know what the appliance did. */
function commandFeedback(category: string): "state" | "none" {
  return category.startsWith("infrared_") || category === "wnykq" ? "none" : "state";
}

export function mapDevice(raw: RawDevice): SmartHomeDevice {
  return {
    id: raw.id,
    provider: "tuya",
    name: sanitizeText(raw.name),
    category: mapCategory(raw.category),
    online: raw.online,
    ...(raw.product_name ? { productName: sanitizeText(raw.product_name) } : {}),
    isSubDevice: raw.sub,
    commandFeedback: commandFeedback(raw.category),
  };
}

export function mapStatus(raw: RawDevice, now: Date, items: RawStatusItem[] = raw.status): DeviceStatus {
  return {
    deviceId: raw.id,
    online: raw.online,
    properties: items
      // A code that is not a plain identifier cannot be a real capability code: drop it rather than pass it on.
      .filter((s) => COMMAND_CODE_PATTERN.test(s.code))
      .slice(0, MAX_PROPERTIES)
      .map((s) => ({ code: s.code, value: sanitizeValue(s.value) })),
    retrievedAt: now.toISOString(),
  };
}

const KINDS: Record<string, CapabilityKind> = {
  boolean: "boolean",
  enum: "enum",
  integer: "integer",
  string: "string",
  json: "json",
  raw: "raw",
  bitmap: "bitmap",
};

function mapKind(type: string): CapabilityKind {
  return KINDS[type.toLowerCase()] ?? "unknown";
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * `values` is a JSON string for most items, but live devices also return plain
 * strings (e.g. "PowerOff") and declared types can disagree with the payload
 * (an ENUM whose values describe an Integer range). Parse defensively and keep
 * whatever is understandable; never throw.
 */
export function parseConstraints(values: unknown): CapabilityConstraints {
  let obj: unknown = values;
  if (typeof values === "string") {
    try {
      obj = JSON.parse(values);
    } catch {
      return values.length > 0 ? { raw: sanitizeText(values, 200) } : {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return typeof values === "string" && values.length > 0 ? { raw: sanitizeText(values, 200) } : {};
  }
  const o = obj as Record<string, unknown>;
  const out: CapabilityConstraints = {};
  const min = num(o.min);
  const max = num(o.max);
  const step = num(o.step);
  const scale = num(o.scale);
  if (min !== undefined) out.min = min;
  if (max !== undefined) out.max = max;
  if (step !== undefined) out.step = step;
  if (scale !== undefined) out.scale = scale;
  if (typeof o.unit === "string" && o.unit) out.unit = sanitizeText(o.unit, 20);
  if (Array.isArray(o.range)) out.range = o.range.filter((r): r is string => typeof r === "string").map((r) => sanitizeText(r, 50));
  return out;
}

/**
 * Merge the writable instruction set (`functions`) and readable status set
 * (`status`) by code. A code in both is read-write. The functions entry wins
 * for kind/constraints because that is what a command must satisfy.
 */
export function mapCapabilities(spec: RawSpec): DeviceCapability[] {
  const byCode = new Map<string, { fn?: RawSpecItem; st?: RawSpecItem }>();
  for (const fn of spec.functions) byCode.set(fn.code, { ...byCode.get(fn.code), fn });
  for (const st of spec.status) byCode.set(st.code, { ...byCode.get(st.code), st });

  return [...byCode.entries()].filter(([code]) => COMMAND_CODE_PATTERN.test(code)).slice(0, MAX_CAPABILITIES).map(([code, { fn, st }]) => {
    const primary = (fn ?? st)!;
    const access: CapabilityAccess = fn && st ? "read-write" : fn ? "write" : "read";
    return {
      code,
      kind: mapKind(primary.type),
      access,
      constraints: parseConstraints(primary.values),
      ...(primary.name ? { name: sanitizeText(primary.name) } : {}),
    };
  });
}
