import { describe, expect, it } from "vitest";
import type { DeviceStatus } from "@/core/domain";
import { sameValue, verifyCommands } from "@/services/verification";

const status = (props: Record<string, unknown>): DeviceStatus => ({
  deviceId: "d",
  online: true,
  properties: Object.entries(props).map(([code, value]) => ({ code, value })),
  retrievedAt: "t",
});

describe("sameValue", () => {
  it("compares booleans tolerantly against provider string encodings", () => {
    expect(sameValue(true, true)).toBe(true);
    expect(sameValue(true, "1")).toBe(true);
    expect(sameValue(true, "true")).toBe(true);
    expect(sameValue(false, "0")).toBe(true);
    expect(sameValue(true, "0")).toBe(false);
    expect(sameValue(false, true)).toBe(false);
  });

  it("compares numbers and strings case-insensitively as text", () => {
    expect(sameValue(24, "24")).toBe(true);
    expect(sameValue(24, 25)).toBe(false);
    expect(sameValue("Cool", "cool")).toBe(true);
  });
});

describe("verifyCommands", () => {
  it("is confirmed when every property matches", () => {
    const v = verifyCommands([{ code: "a", value: true }, { code: "b", value: 5 }], status({ a: true, b: 5 }));
    expect(v.result).toBe("confirmed");
    expect(v.details.every((d) => d.outcome === "confirmed")).toBe(true);
  });

  it("is mismatch when a property differs, even if others match", () => {
    const v = verifyCommands([{ code: "a", value: true }, { code: "b", value: 5 }], status({ a: true, b: 6 }));
    expect(v.result).toBe("mismatch");
    expect(v.details.find((d) => d.code === "b")).toMatchObject({ outcome: "mismatch", actual: 6, expected: 5 });
  });

  it("is partially_verified when some properties cannot be compared", () => {
    const v = verifyCommands([{ code: "a", value: true }, { code: "ghost", value: 1 }], status({ a: true }));
    expect(v.result).toBe("partially_verified");
  });

  it("is not_verifiable when no property can be compared", () => {
    expect(verifyCommands([{ code: "PowerOn", value: "PowerOn" }], status({ power: "1" })).result).toBe("not_verifiable");
  });

  it("a mismatch outranks unverifiable properties", () => {
    expect(verifyCommands([{ code: "a", value: 1 }, { code: "z", value: 1 }], status({ a: 2 })).result).toBe("mismatch");
  });
});
