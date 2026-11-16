import { describe, expect, it } from "vitest";
import type { DeviceCapability } from "@/core/domain";
import { validateCommands } from "@/core/domain/command-validation";
import { resolvePowerCommand } from "@/services/power";

const cap = (code: string, kind: DeviceCapability["kind"], access: DeviceCapability["access"], constraints: DeviceCapability["constraints"] = {}): DeviceCapability => ({ code, kind, access, constraints });

const caps: DeviceCapability[] = [
  cap("switch_led", "boolean", "read-write"),
  cap("bright", "integer", "write", { min: 10, max: 100, step: 5 }),
  cap("mode", "enum", "write", { range: ["white", "colour"] }),
  cap("T", "enum", "write", { min: 16, max: 30, step: 1 }),
  cap("PowerOn", "string", "write", { raw: "PowerOn" }),
  cap("label", "string", "write"),
  cap("temp_now", "integer", "read", { min: 0, max: 100 }),
  cap("colour_data", "json", "write"),
  cap("blob", "raw", "write"),
];

const run = (code: string, value: string | number | boolean) => () => validateCommands(caps, [{ code, value }]);

describe("validateCommands: capability presence and access", () => {
  it("accepts a valid command", () => {
    expect(run("switch_led", true)).not.toThrow();
  });

  it("rejects a code the device does not have as UNSUPPORTED_OPERATION", () => {
    expect(run("nonexistent", true)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }));
  });

  it("rejects writing a read-only capability as UNSUPPORTED_OPERATION", () => {
    expect(run("temp_now", 5)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_OPERATION", message: expect.stringContaining("read-only") }));
  });

  it("refuses json/raw capabilities rather than guessing a format", () => {
    expect(run("colour_data", "x")).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }));
    expect(run("blob", "x")).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }));
  });
});

describe("validateCommands: values", () => {
  it.each([
    ["boolean given a string", "switch_led", "on"],
    ["boolean given a number", "switch_led", 1],
    ["integer below min", "bright", 5],
    ["integer above max", "bright", 105],
    ["integer off the step grid", "bright", 12],
    ["integer given a float", "bright", 20.5],
    ["integer given a string", "bright", "20"],
    ["enum not in range", "mode", "rainbow"],
    ["enum given a number", "mode", 1],
    ["numeric-enum below min", "T", 10],
    ["numeric-enum above max", "T", 31],
    ["fixed string with another value", "PowerOn", "PowerOff"],
    ["string too long", "label", "x".repeat(256)],
  ])("rejects %s as INVALID_DEVICE_COMMAND", (_label, code, value) => {
    expect(run(code, value as never)).toThrowError(expect.objectContaining({ code: "INVALID_DEVICE_COMMAND" }));
  });

  it.each([
    ["integer on the step grid", "bright", 55],
    ["integer at min and max", "bright", 10],
    ["integer at max", "bright", 100],
    ["enum in range", "mode", "colour"],
    ["numeric-enum in range", "T", 24],
    ["fixed string exactly", "PowerOn", "PowerOn"],
    ["free string", "label", "Reading light"],
  ])("accepts %s", (_label, code, value) => {
    expect(run(code, value as never)).not.toThrow();
  });

  it("explains the allowed values in the error message", () => {
    expect(run("mode", "rainbow")).toThrowError(/white, colour/);
    expect(run("bright", 5)).toThrowError(/between 10 and 100/);
  });
});

describe("validateCommands: command lists", () => {
  it("rejects empty and oversized lists", () => {
    expect(() => validateCommands(caps, [])).toThrowError(expect.objectContaining({ code: "INVALID_DEVICE_COMMAND" }));
    const many = Array.from({ length: 11 }, () => ({ code: "switch_led", value: true }));
    expect(() => validateCommands(caps, many)).toThrowError(expect.objectContaining({ code: "INVALID_DEVICE_COMMAND" }));
  });

  it("rejects duplicate codes in one call", () => {
    expect(() =>
      validateCommands(caps, [
        { code: "switch_led", value: true },
        { code: "switch_led", value: false },
      ]),
    ).toThrowError(/more than once/);
  });

  it("is all-or-nothing: one bad command invalidates the list", () => {
    expect(() =>
      validateCommands(caps, [
        { code: "switch_led", value: true },
        { code: "bright", value: 999 },
      ]),
    ).toThrow();
  });

  it.each(["../x", "a b", "a/b", "", "x".repeat(65), "a;b"])("rejects a malformed code %j", (bad) => {
    expect(() => validateCommands(caps, [{ code: bad, value: true }])).toThrowError(expect.objectContaining({ code: "INVALID_DEVICE_COMMAND" }));
  });
});

describe("resolvePowerCommand", () => {
  it("uses the device's own boolean switch capability", () => {
    expect(resolvePowerCommand([cap("switch_led", "boolean", "read-write")], true)).toEqual({ code: "switch_led", value: true });
    expect(resolvePowerCommand([cap("switch", "boolean", "write")], false)).toEqual({ code: "switch", value: false });
  });

  it("uses the fixed PowerOn/PowerOff keys of infrared devices", () => {
    const ir = [cap("PowerOn", "string", "write", { raw: "PowerOn" }), cap("PowerOff", "string", "write", { raw: "PowerOff" })];
    expect(resolvePowerCommand(ir, true)).toEqual({ code: "PowerOn", value: "PowerOn" });
    expect(resolvePowerCommand(ir, false)).toEqual({ code: "PowerOff", value: "PowerOff" });
  });

  it("refuses a device without a recognizable power capability instead of guessing", () => {
    expect(() => resolvePowerCommand([cap("bright", "integer", "write")], true)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }));
    expect(() => resolvePowerCommand([], true)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }));
  });

  it("ignores read-only or non-boolean look-alikes", () => {
    expect(() => resolvePowerCommand([cap("switch", "boolean", "read")], true)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }));
    expect(() => resolvePowerCommand([cap("switch", "string", "write")], true)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }));
    // A PowerOn key whose fixed value is something else is not the documented IR key.
    expect(() => resolvePowerCommand([cap("PowerOn", "string", "write", { raw: "other" })], true)).toThrow();
  });

  it("refuses to choose between several switches and lists the candidates", () => {
    const err = (() => {
      try {
        resolvePowerCommand([cap("switch_1", "boolean", "write"), cap("switch", "boolean", "write")], true);
      } catch (e) {
        return e as { code: string; context?: Record<string, unknown> };
      }
    })();
    expect(err?.code).toBe("INVALID_DEVICE_COMMAND");
    expect(String(err?.context?.candidates)).toContain("switch_1");
  });
});
