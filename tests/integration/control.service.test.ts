import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/core/errors";
import type { SmartHomeProvider } from "@/providers/provider.interface";
import { ConfirmationManager, createConfirmationPolicy } from "@/security/confirmation";
import { FixedWindowRateLimiter } from "@/security/rate-limit";
import { createServices } from "@/services/container";
import type { ControlResult } from "@/services/control.service";
import { smartFleet, testControlDeps } from "../helpers/smart-fleet";

const actor = { actor: "write-key" };

function setup(options: { ignoreCommands?: boolean; deps?: Parameters<typeof testControlDeps>[0] } = {}) {
  const fleet = smartFleet({ ignoreCommands: options.ignoreCommands ?? false });
  const services = createServices(fleet.provider, testControlDeps(options.deps));
  return { ...fleet, control: services.control };
}

const executed = (r: ControlResult) => {
  expect(r.status).toBe("executed");
  return r as Extract<ControlResult, { status: "executed" }>;
};

describe("ControlService: standard devices", () => {
  it("turns a lamp on using its own switch capability and confirms the new state", async () => {
    const { control, sent, props } = setup();
    const r = executed(await control.turnOn(actor, "lamp"));
    expect(sent).toEqual([{ deviceId: "lamp", commands: [{ code: "switch_led", value: true }] }]);
    expect(props.lamp!.switch_led).toBe(true);
    expect(r).toMatchObject({ accepted: true, verification: { result: "confirmed" } });
  });

  it("turns it off again", async () => {
    const { control, props } = setup();
    await control.turnOn(actor, "lamp");
    expect(executed(await control.turnOff(actor, "lamp")).verification.result).toBe("confirmed");
    expect(props.lamp!.switch_led).toBe(false);
  });

  it("sets a valid property and verifies it", async () => {
    const { control, props } = setup();
    const r = executed(await control.setProperty(actor, "lamp", "bright_value", 500));
    expect(props.lamp!.bright_value).toBe(500);
    expect(r.verification.result).toBe("confirmed");
  });

  it("executes several commands in ONE provider request", async () => {
    const { control, sent } = setup();
    const r = executed(
      await control.execute(actor, "lamp", [
        { code: "switch_led", value: true },
        { code: "bright_value", value: 250 },
      ]),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.commands).toHaveLength(2);
    expect(r.verification.result).toBe("confirmed");
  });

  it("reports a MISMATCH when the provider accepts but the device did not change", async () => {
    const { control, sent } = setup({ ignoreCommands: true });
    const r = executed(await control.turnOn(actor, "lamp"));
    expect(sent).toHaveLength(1);
    expect(r.accepted).toBe(true);
    expect(r.verification.result).toBe("mismatch");
    expect(r.verification.details[0]).toMatchObject({ code: "switch_led", expected: true, actual: false, outcome: "mismatch" });
  });

  it("re-reads state with a delay so a slow device can still be confirmed", async () => {
    const fleet = smartFleet();
    let reads = 0;
    const lagging: SmartHomeProvider = {
      ...fleet.provider,
      sendCommands: async () => {},
      getDeviceStatus: async (id) => {
        reads++;
        return { deviceId: id, online: true, properties: [{ code: "switch_led", value: reads >= 2 }], retrievedAt: "t" };
      },
    };
    const sleep = vi.fn(async () => {});
    const { control } = createServices(lagging, testControlDeps({ sleep, verifyDelaysMs: [10, 20] }));
    expect(executed(await control.turnOn(actor, "lamp")).verification.result).toBe("confirmed");
    expect(reads).toBe(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("does not turn a failed read-back into an error: the command was accepted", async () => {
    const fleet = smartFleet();
    const flaky: SmartHomeProvider = {
      ...fleet.provider,
      getDeviceStatus: async () => {
        throw new AppError("PROVIDER_UNAVAILABLE", "down");
      },
    };
    const { control } = createServices(flaky, testControlDeps());
    const r = executed(await control.turnOn(actor, "lamp"));
    expect(r.verification.result).toBe("not_verifiable");
    expect(r.verification.note).toMatch(/could not be read back/);
  });
});

describe("ControlService: infrared devices (no feedback)", () => {
  it("sends the fixed power key and says the result is NOT verifiable, without pretending to verify", async () => {
    const fleet = smartFleet();
    const status = vi.spyOn(fleet.provider, "getDeviceStatus");
    const { control } = createServices(fleet.provider, testControlDeps());
    const r = executed(await control.turnOn(actor, "ir-ac"));
    expect(fleet.sent[0]).toEqual({ deviceId: "ir-ac", commands: [{ code: "PowerOn", value: "PowerOn" }] });
    expect(r.verification.result).toBe("not_verifiable");
    expect(r.verification.note).toMatch(/no state feedback/i);
    expect(status).not.toHaveBeenCalled(); // reading state back would only echo our own command
  });

  it("validates IR values too (temperature range)", async () => {
    const { control, sent } = setup();
    await expect(control.setProperty(actor, "ir-ac", "T", 40)).rejects.toMatchObject({ code: "INVALID_DEVICE_COMMAND" });
    expect(sent).toEqual([]);
    expect(executed(await control.setProperty(actor, "ir-ac", "T", 24)).verification.result).toBe("not_verifiable");
  });
});

describe("ControlService: refusals happen before anything is sent", () => {
  it.each([
    ["unknown device", (c: ReturnType<typeof setup>["control"]) => c.turnOn(actor, "ghost"), "DEVICE_NOT_FOUND"],
    ["unsafe device id", (c: ReturnType<typeof setup>["control"]) => c.turnOn(actor, "../token"), "DEVICE_NOT_FOUND"],
    ["offline device", (c: ReturnType<typeof setup>["control"]) => c.turnOn(actor, "lamp2"), "DEVICE_OFFLINE"],
    ["read-only sensor (power)", (c: ReturnType<typeof setup>["control"]) => c.turnOn(actor, "sensor"), "UNSUPPORTED_OPERATION"],
    ["read-only sensor (property)", (c: ReturnType<typeof setup>["control"]) => c.setProperty(actor, "sensor", "va_temperature", 1), "UNSUPPORTED_OPERATION"],
    ["capability the device lacks", (c: ReturnType<typeof setup>["control"]) => c.setProperty(actor, "lamp", "colour_data", "x"), "UNSUPPORTED_OPERATION"],
    ["ambiguous power switches", (c: ReturnType<typeof setup>["control"]) => c.turnOn(actor, "multi"), "INVALID_DEVICE_COMMAND"],
    ["value out of range", (c: ReturnType<typeof setup>["control"]) => c.setProperty(actor, "lamp", "bright_value", 5), "INVALID_DEVICE_COMMAND"],
    ["wrong value type", (c: ReturnType<typeof setup>["control"]) => c.setProperty(actor, "lamp", "switch_led", "on"), "INVALID_DEVICE_COMMAND"],
    ["empty command list", (c: ReturnType<typeof setup>["control"]) => c.execute(actor, "lamp", []), "INVALID_DEVICE_COMMAND"],
  ])("%s", async (_label, act, code) => {
    const { control, sent } = setup();
    await expect(act(control)).rejects.toMatchObject({ code });
    expect(sent).toEqual([]);
  });

  it("is all-or-nothing: a valid command is not sent when another in the list is invalid", async () => {
    const { control, sent, props } = setup();
    await expect(
      control.execute(actor, "lamp", [
        { code: "switch_led", value: true },
        { code: "bright_value", value: 99999 },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_DEVICE_COMMAND" });
    expect(sent).toEqual([]);
    expect(props.lamp!.switch_led).toBe(false);
  });

  it("propagates provider rejection without claiming success", async () => {
    const fleet = smartFleet();
    const rejecting: SmartHomeProvider = {
      ...fleet.provider,
      sendCommands: async () => {
        throw new AppError("UNSUPPORTED_OPERATION", "The device does not support this operation.");
      },
    };
    const { control } = createServices(rejecting, testControlDeps());
    await expect(control.turnOn(actor, "lamp")).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });
});

describe("ControlService: confirmation for high-impact actions", () => {
  it("does NOT execute on the first call and returns a token", async () => {
    const { control, sent } = setup();
    const r = await control.setProperty(actor, "door", "lock_motor_state", false);
    expect(r.status).toBe("confirmation_required");
    expect(sent).toEqual([]);
    expect(r).toMatchObject({ confirmation: { expiresInSeconds: 300 } });
    expect((r as { confirmation: { token: string } }).confirmation.token.length).toBeGreaterThan(20);
  });

  it("executes on the second call with the token, once only", async () => {
    const { control, sent, props } = setup();
    const first = (await control.setProperty(actor, "door", "lock_motor_state", false)) as Extract<ControlResult, { status: "confirmation_required" }>;
    const token = first.confirmation.token;
    expect(executed(await control.setProperty(actor, "door", "lock_motor_state", false, token)).verification.result).toBe("confirmed");
    expect(sent).toHaveLength(1);
    expect(props.door!.lock_motor_state).toBe(false);
    // Replay with the same token is refused and sends nothing more.
    await expect(control.setProperty(actor, "door", "lock_motor_state", false, token)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(sent).toHaveLength(1);
  });

  it("refuses a token used for a different action, device or actor", async () => {
    const { control, sent } = setup();
    const { confirmation } = (await control.setProperty(actor, "door", "lock_motor_state", false)) as Extract<ControlResult, { status: "confirmation_required" }>;
    await expect(control.setProperty(actor, "door", "lock_motor_state", true, confirmation.token)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    await expect(control.setProperty({ actor: "someone-else" }, "door", "lock_motor_state", false, confirmation.token)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(sent).toEqual([]);
  });

  it("refuses a token signed with a different secret", async () => {
    const a = setup();
    const b = setup({ deps: { confirmations: new ConfirmationManager("another-secret-0123456789abcdef") } });
    const { confirmation } = (await a.control.setProperty(actor, "door", "lock_motor_state", false)) as Extract<ControlResult, { status: "confirmation_required" }>;
    await expect(b.control.setProperty(actor, "door", "lock_motor_state", false, confirmation.token)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(b.sent).toEqual([]);
  });

  it("does not issue tokens for invalid or impossible actions (validation runs first)", async () => {
    const { control } = setup();
    await expect(control.setProperty(actor, "door", "lock_motor_state", "yes")).rejects.toMatchObject({ code: "INVALID_DEVICE_COMMAND" });
    await expect(control.setProperty(actor, "ghost", "lock_motor_state", true)).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });

  it("can require confirmation for every action", async () => {
    const { control, sent } = setup({ deps: { policy: createConfirmationPolicy({ categories: [], confirmAll: true }) } });
    expect((await control.turnOn(actor, "lamp")).status).toBe("confirmation_required");
    expect(sent).toEqual([]);
  });

  it("ordinary devices need no token", async () => {
    const { control } = setup();
    expect((await control.turnOn(actor, "lamp")).status).toBe("executed");
  });
});

describe("ControlService: write rate limiting", () => {
  it("limits control operations per actor and sends nothing once exceeded", async () => {
    const { control, sent } = setup({ deps: { limiter: new FixedWindowRateLimiter(2) } });
    await control.setProperty(actor, "lamp", "bright_value", 100);
    await control.setProperty(actor, "lamp", "bright_value", 200);
    await expect(control.setProperty(actor, "lamp", "bright_value", 300)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true });
    expect(sent).toHaveLength(2);
    // Another actor has its own budget.
    await expect(control.setProperty({ actor: "other" }, "lamp", "bright_value", 300)).resolves.toMatchObject({ status: "executed" });
  });
});
