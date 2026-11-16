import { afterEach, describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "@/security/rate-limit";
import { READ_ID, READ_KEY, WRITE_ID, WRITE_KEY, createHarness, type Harness } from "../helpers/mcp-harness";
import { smartFleet, testControlDeps } from "../helpers/smart-fleet";

let h: Harness;
afterEach(async () => h?.close());

const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

function start(options: { ignoreCommands?: boolean; writeLimit?: number } = {}) {
  const fleet = smartFleet({ ignoreCommands: options.ignoreCommands ?? false });
  h = createHarness({
    provider: fleet.provider,
    control: testControlDeps(options.writeLimit ? { limiter: new FixedWindowRateLimiter(options.writeLimit) } : {}),
  });
  return fleet;
}

type Structured = {
  status: string;
  accepted?: boolean;
  verification?: { result: string; note?: string };
  confirmation?: { token: string; instruction: string };
};
const sc = (r: { structuredContent?: unknown }) => r.structuredContent as Structured;

describe("control tools: authorization", () => {
  it.each([
    ["turn_on_device", { deviceId: "lamp" }],
    ["turn_off_device", { deviceId: "lamp" }],
    ["set_device_property", { deviceId: "lamp", code: "bright_value", value: 200 }],
    ["execute_device_command", { deviceId: "lamp", commands: [{ code: "switch_led", value: true }] }],
  ])("the READ key cannot call %s; nothing is sent and the denial is audited", async (name, args) => {
    const fleet = start();
    const r = await (await h.connect(READ_KEY)).callTool({ name, arguments: args });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("AUTHORIZATION_FAILED");
    expect(fleet.sent).toEqual([]);
    expect(h.audit).toContainEqual(expect.objectContaining({ actor: READ_ID, action: `tool:${name}`, write: true, outcome: "denied" }));
  });

  it("the read key still reads everything", async () => {
    start();
    const r = await (await h.connect(READ_KEY)).callTool({ name: "get_device_status", arguments: { deviceId: "lamp" } });
    expect(r.isError).toBeFalsy();
  });
});

describe("control tools: execution and honest reporting", () => {
  it("turn_on_device executes, verifies, and the text says it was confirmed", async () => {
    const fleet = start();
    const r = await (await h.connect(WRITE_KEY)).callTool({ name: "turn_on_device", arguments: { deviceId: "lamp" } });
    expect(r.isError).toBeFalsy();
    expect(sc(r)).toMatchObject({ status: "executed", accepted: true, verification: { result: "confirmed" } });
    expect(textOf(r as never)).toMatch(/AND the device state was read back/);
    expect(fleet.props.lamp!.switch_led).toBe(true);
    expect(h.audit).toContainEqual(
      expect.objectContaining({ actor: WRITE_ID, action: "tool:turn_on_device", write: true, outcome: "success", deviceIds: ["lamp"], note: "executed:confirmed codes=switch_led" }),
    );
  });

  it("turn_off_device, set_device_property and execute_device_command work", async () => {
    const fleet = start();
    const client = await h.connect(WRITE_KEY);
    await client.callTool({ name: "turn_on_device", arguments: { deviceId: "lamp" } });
    expect(sc(await client.callTool({ name: "turn_off_device", arguments: { deviceId: "lamp" } })).verification?.result).toBe("confirmed");
    expect(sc(await client.callTool({ name: "set_device_property", arguments: { deviceId: "lamp", code: "bright_value", value: 300 } })).verification?.result).toBe("confirmed");
    const multi = await client.callTool({
      name: "execute_device_command",
      arguments: { deviceId: "lamp", commands: [{ code: "switch_led", value: true }, { code: "bright_value", value: 400 }] },
    });
    expect(sc(multi).verification?.result).toBe("confirmed");
    expect(fleet.props.lamp).toEqual({ switch_led: true, bright_value: 400 });
  });

  it("warns not to claim success when the device did not change (mismatch)", async () => {
    start({ ignoreCommands: true });
    const r = await (await h.connect(WRITE_KEY)).callTool({ name: "turn_on_device", arguments: { deviceId: "lamp" } });
    expect(sc(r)).toMatchObject({ status: "executed", accepted: true, verification: { result: "mismatch" } });
    expect(textOf(r as never)).toMatch(/does NOT match/);
    expect(textOf(r as never)).toMatch(/Do not report success/);
  });

  it("says plainly that an infrared command could not be verified", async () => {
    start();
    const r = await (await h.connect(WRITE_KEY)).callTool({ name: "turn_on_device", arguments: { deviceId: "ir-ac" } });
    expect(sc(r)).toMatchObject({ status: "executed", verification: { result: "not_verifiable" } });
    expect(sc(r).verification?.note).toMatch(/no state feedback/i);
    expect(textOf(r as never)).toMatch(/could NOT be verified/);
    expect(textOf(r as never)).toMatch(/Do not claim it succeeded/);
  });
});

describe("control tools: rejection", () => {
  it.each([
    ["offline device", "turn_on_device", { deviceId: "lamp2" }, "DEVICE_OFFLINE"],
    ["unknown device", "turn_on_device", { deviceId: "ghost" }, "DEVICE_NOT_FOUND"],
    ["no power capability", "turn_on_device", { deviceId: "sensor" }, "UNSUPPORTED_OPERATION"],
    ["unsupported property", "set_device_property", { deviceId: "lamp", code: "colour_data", value: "x" }, "UNSUPPORTED_OPERATION"],
    ["read-only property", "set_device_property", { deviceId: "sensor", code: "va_temperature", value: 1 }, "UNSUPPORTED_OPERATION"],
    ["out-of-range value", "set_device_property", { deviceId: "lamp", code: "bright_value", value: 5 }, "INVALID_DEVICE_COMMAND"],
    ["wrong type", "set_device_property", { deviceId: "lamp", code: "switch_led", value: "on" }, "INVALID_DEVICE_COMMAND"],
  ])("%s -> %s and nothing is sent", async (_label, name, args, code) => {
    const fleet = start();
    const r = await (await h.connect(WRITE_KEY)).callTool({ name, arguments: args });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain(code);
    expect(fleet.sent).toEqual([]);
    expect(h.audit).toContainEqual(expect.objectContaining({ action: `tool:${name}`, outcome: "failure", errorCode: code }));
  });

  it("rejects malformed arguments at the schema level (handler never runs)", async () => {
    const fleet = start();
    const client = await h.connect(WRITE_KEY);
    const bad = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }).catch(() => ({ isError: true }));
      expect((r as { isError?: boolean }).isError).toBe(true);
    };
    await bad("set_device_property", { deviceId: "lamp", code: "bright_value" }); // missing value
    await bad("set_device_property", { deviceId: "lamp", code: "bright_value", value: { nested: 1 } });
    await bad("set_device_property", { deviceId: "lamp", code: "../x", value: 1 });
    await bad("set_device_property", { deviceId: "../lamp", code: "a", value: 1 });
    await bad("execute_device_command", { deviceId: "lamp", commands: [] });
    await bad("execute_device_command", { deviceId: "lamp", commands: Array.from({ length: 11 }, (_, i) => ({ code: `c${i}`, value: 1 })) });
    await bad("turn_on_device", { deviceId: "lamp", confirmationToken: "x".repeat(2000) });
    expect(fleet.sent).toEqual([]);
    expect(h.audit.filter((e) => e.write)).toEqual([]);
  });

  it("exposes no way to send raw provider requests", async () => {
    start();
    const { tools } = await (await h.connect(WRITE_KEY)).listTools();
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props).not.toEqual(expect.arrayContaining(["url"]));
      expect(props).not.toEqual(expect.arrayContaining(["path"]));
      expect(props).not.toEqual(expect.arrayContaining(["headers"]));
    }
  });
});

describe("control tools: two-step confirmation", () => {
  it("does not execute the first call, executes the confirmed repeat, and refuses replay", async () => {
    const fleet = start();
    const client = await h.connect(WRITE_KEY);
    const args = { deviceId: "door", code: "lock_motor_state", value: false };

    const first = await client.callTool({ name: "set_device_property", arguments: args });
    expect(first.isError).toBeFalsy();
    expect(sc(first).status).toBe("confirmation_required");
    expect(textOf(first as never)).toMatch(/NOT EXECUTED/);
    expect(sc(first).confirmation?.instruction).toMatch(/explicitly confirm/i);
    expect(fleet.sent).toEqual([]);
    expect(h.audit).toContainEqual(expect.objectContaining({ action: "tool:set_device_property", outcome: "success", note: expect.stringContaining("confirmation_required") }));

    const token = sc(first).confirmation!.token;
    const second = await client.callTool({ name: "set_device_property", arguments: { ...args, confirmationToken: token } });
    expect(sc(second)).toMatchObject({ status: "executed", verification: { result: "confirmed" } });
    expect(fleet.sent).toHaveLength(1);

    const replay = await client.callTool({ name: "set_device_property", arguments: { ...args, confirmationToken: token } });
    expect(replay.isError).toBe(true);
    expect(textOf(replay as never)).toContain("AUTHORIZATION_FAILED");
    expect(fleet.sent).toHaveLength(1);
  });

  it("a token cannot be reused for a different value", async () => {
    const fleet = start();
    const client = await h.connect(WRITE_KEY);
    const first = await client.callTool({ name: "set_device_property", arguments: { deviceId: "door", code: "lock_motor_state", value: false } });
    const r = await client.callTool({
      name: "set_device_property",
      arguments: { deviceId: "door", code: "lock_motor_state", value: true, confirmationToken: sc(first).confirmation!.token },
    });
    expect(r.isError).toBe(true);
    expect(fleet.sent).toEqual([]);
  });

  it("the read key cannot even obtain a token", async () => {
    start();
    const r = await (await h.connect(READ_KEY)).callTool({ name: "set_device_property", arguments: { deviceId: "door", code: "lock_motor_state", value: false } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("confirmation_required");
  });
});

describe("control tools: write rate limit and leakage", () => {
  it("limits control calls through MCP", async () => {
    const fleet = start({ writeLimit: 2 });
    const client = await h.connect(WRITE_KEY);
    const call = () => client.callTool({ name: "set_device_property", arguments: { deviceId: "lamp", code: "bright_value", value: 100 } });
    await call();
    await call();
    const third = await call();
    expect(third.isError).toBe(true);
    expect(textOf(third as never)).toContain("PROVIDER_RATE_LIMITED");
    expect(fleet.sent).toHaveLength(2);
  });

  it("never exposes API keys or the confirmation signing secret in control outputs", async () => {
    start();
    const client = await h.connect(WRITE_KEY);
    const outputs = [
      await client.callTool({ name: "turn_on_device", arguments: { deviceId: "lamp" } }),
      await client.callTool({ name: "set_device_property", arguments: { deviceId: "door", code: "lock_motor_state", value: false } }),
      await client.callTool({ name: "turn_on_device", arguments: { deviceId: "ghost" } }),
    ];
    const all = JSON.stringify(outputs);
    for (const secret of [READ_KEY, WRITE_KEY, "r".repeat(43), "w".repeat(43), "test-confirmation-secret-0123456789"]) expect(all).not.toContain(secret);
  });
});
