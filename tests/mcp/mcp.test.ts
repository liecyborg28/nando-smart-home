import { afterEach, describe, expect, it } from "vitest";
import { UNTRUSTED_NOTICE } from "@/mcp/format";
import { createHarness, defaultFleet, device, fakeProvider, type Harness } from "../helpers/mcp-harness";

let h: Harness;
afterEach(async () => h?.close());

const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

const EXPECTED_TOOLS = [
  "list_devices",
  "get_device",
  "get_device_capabilities",
  "get_device_status",
  "get_multiple_device_status",
  "get_smart_home_overview",
  "check_provider_connection",
  "turn_on_device",
  "turn_off_device",
  "set_device_property",
  "execute_device_command",
];
const CONTROL_TOOLS = ["turn_on_device", "turn_off_device", "set_device_property", "execute_device_command"];

describe("MCP handshake and discovery", () => {
  it("completes the initialize/negotiation handshake and identifies the server", async () => {
    h = createHarness();
    const client = await h.connect();
    expect(client.getServerVersion()).toMatchObject({ name: "nando-smart-home" });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} });
  });

  it("lists all 11 tools with descriptions, schemas and correct read/write annotations", async () => {
    h = createHarness();
    const { tools } = await (await h.connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema).toBeDefined();
      if (CONTROL_TOOLS.includes(t.name)) expect(t.annotations).toMatchObject({ readOnlyHint: false });
      else expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
  });

  it("never exposes an arbitrary-HTTP or credential tool", async () => {
    h = createHarness();
    const { tools } = await (await h.connect()).listTools();
    for (const t of tools) expect(t.name).not.toMatch(/http|request|fetch|token|secret|credential|url/i);
  });

  it("lists static resources and templates", async () => {
    h = createHarness();
    const client = await h.connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["smarthome://devices", "smarthome://overview", "smarthome://capabilities", "smarthome://devices/ac1", "smarthome://devices/hub1"]));
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(["smarthome://devices/{deviceId}", "smarthome://devices/{deviceId}/status"]);
  });

  it("lists the four prompts", async () => {
    h = createHarness();
    const { prompts } = await (await h.connect()).listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["device_diagnostics", "energy_monitoring", "home_status_summary", "smart_home_assistant"]);
  });
});

describe("MCP tool calls", () => {
  it("list_devices returns structured devices and the untrusted-data notice", async () => {
    h = createHarness();
    const r = await (await h.connect()).callTool({ name: "list_devices", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ count: 2 });
    expect((r.structuredContent as { devices: unknown[] }).devices).toHaveLength(2);
    expect(textOf(r as never)).toContain(UNTRUSTED_NOTICE);
  });

  it("list_devices applies category and online filters", async () => {
    h = createHarness({ provider: fakeProvider([...defaultFleet, device("l1", "light", false)]) });
    const client = await h.connect();
    const light = await client.callTool({ name: "list_devices", arguments: { category: "light" } });
    expect((light.structuredContent as { count: number }).count).toBe(1);
    const online = await client.callTool({ name: "list_devices", arguments: { online: true } });
    expect((online.structuredContent as { count: number }).count).toBe(2);
  });

  it("get_device, get_device_status and get_device_capabilities work for a known device", async () => {
    h = createHarness();
    const client = await h.connect();
    expect((await client.callTool({ name: "get_device", arguments: { deviceId: "ac1" } })).structuredContent).toMatchObject({ device: { id: "ac1" } });
    expect((await client.callTool({ name: "get_device_status", arguments: { deviceId: "ac1" } })).structuredContent).toMatchObject({
      status: { deviceId: "ac1", properties: [{ code: "power", value: "1" }] },
    });
    expect((await client.callTool({ name: "get_device_capabilities", arguments: { deviceId: "ac1" } })).structuredContent).toMatchObject({
      count: 1,
      capabilities: [{ code: "T", access: "write" }],
    });
  });

  it("returns a normalized error for an unknown device (DEVICE_NOT_FOUND)", async () => {
    h = createHarness();
    const r = await (await h.connect()).callTool({ name: "get_device", arguments: { deviceId: "nope" } });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("DEVICE_NOT_FOUND");
  });

  it("returns UNSUPPORTED_OPERATION for a device without a specification", async () => {
    h = createHarness();
    const r = await (await h.connect()).callTool({ name: "get_device_capabilities", arguments: { deviceId: "hub1" } });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("UNSUPPORTED_OPERATION");
  });

  it("get_multiple_device_status returns per-device results including failures", async () => {
    h = createHarness();
    const r = await (await h.connect()).callTool({ name: "get_multiple_device_status", arguments: { deviceIds: ["ac1", "ghost", "ac1"] } });
    const results = (r.structuredContent as { results: Array<{ deviceId: string; ok: boolean; error?: { code: string } }> }).results;
    expect(results.map((x) => [x.deviceId, x.ok])).toEqual([["ac1", true], ["ghost", false]]);
    expect(results[1]!.error?.code).toBe("DEVICE_NOT_FOUND");
  });

  it("get_smart_home_overview and check_provider_connection work", async () => {
    h = createHarness();
    const client = await h.connect();
    expect((await client.callTool({ name: "get_smart_home_overview", arguments: {} })).structuredContent).toMatchObject({ total: 2, online: 2, offline: 0 });
    expect((await client.callTool({ name: "check_provider_connection", arguments: {} })).structuredContent).toEqual({ provider: "tuya", connected: true });
  });

  it("reports a provider failure as a safe tool error", async () => {
    h = createHarness({
      provider: fakeProvider(defaultFleet, {
        checkConnection: async () => {
          throw new Error("boom: client_secret=SUPERSECRET");
        },
      }),
    });
    const r = await (await h.connect()).callTool({ name: "check_provider_connection", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("INTERNAL_ERROR");
    expect(textOf(r as never)).not.toContain("SUPERSECRET");
  });
});

describe("MCP input validation", () => {
  it.each(["../token", "a/b", "a?x=1", "", "x".repeat(65), "id with space"])("rejects unsafe device id %j before any handler logic", async (bad) => {
    h = createHarness();
    const client = await h.connect();
    const r = await client.callTool({ name: "get_device", arguments: { deviceId: bad } }).catch((e: unknown) => ({ thrown: e }));
    expect("thrown" in r || (r as { isError?: boolean }).isError === true).toBe(true);
    expect(h.audit.filter((e) => e.action === "tool:get_device")).toHaveLength(0); // handler never ran
  });

  it("rejects missing, wrongly typed and oversized arguments", async () => {
    h = createHarness();
    const client = await h.connect();
    const bad = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }).catch(() => ({ isError: true }));
      expect((r as { isError?: boolean }).isError).toBe(true);
    };
    await bad("get_device", {});
    await bad("get_device", { deviceId: 123 });
    await bad("get_multiple_device_status", { deviceIds: [] });
    await bad("get_multiple_device_status", { deviceIds: Array.from({ length: 21 }, (_, i) => `d${i}`) });
    await bad("list_devices", { online: "yes" });
  });
});

describe("MCP resources", () => {
  const read = async (client: Awaited<ReturnType<Harness["connect"]>>, uri: string) => {
    const { contents } = await client.readResource({ uri });
    return JSON.parse((contents[0] as { text: string }).text) as { notice: string; data: Record<string, unknown> };
  };

  it("reads devices, overview, one device, its status and the capability catalog", async () => {
    h = createHarness();
    const client = await h.connect();
    expect((await read(client, "smarthome://devices")).data.devices).toHaveLength(2);
    expect(await read(client, "smarthome://overview")).toMatchObject({ data: { total: 2 } });
    expect(await read(client, "smarthome://devices/ac1")).toMatchObject({ data: { device: { id: "ac1" } } });
    expect(await read(client, "smarthome://devices/ac1/status")).toMatchObject({ data: { status: { deviceId: "ac1" } } });
    const catalog = (await read(client, "smarthome://capabilities")).data as { entries: Array<{ deviceId: string; error?: { code: string }; capabilities: unknown[] }> };
    expect(catalog.entries.find((e) => e.deviceId === "ac1")!.capabilities).toHaveLength(1);
    expect(catalog.entries.find((e) => e.deviceId === "hub1")!.error?.code).toBe("UNSUPPORTED_OPERATION");
  });

  it("labels resource data as untrusted", async () => {
    h = createHarness();
    const r = await read(await h.connect(), "smarthome://devices");
    expect(r.notice).toBe(UNTRUSTED_NOTICE);
  });

  it("returns a not-found error for an unknown device resource", async () => {
    h = createHarness();
    await expect((await h.connect()).readResource({ uri: "smarthome://devices/ghost" })).rejects.toThrow();
  });
});

describe("MCP prompts", () => {
  it("returns usable, tool-referencing messages", async () => {
    h = createHarness();
    const client = await h.connect();
    const p = await client.getPrompt({ name: "device_diagnostics", arguments: { device: "Living room AC" } });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain("Living room AC");
    expect(text).toContain("get_device_status");
    expect(text).toMatch(/never guess/i);

    const summary = await client.getPrompt({ name: "home_status_summary" });
    expect((summary.messages[0]!.content as { text: string }).text).toContain("get_smart_home_overview");
  });

  it("does not hardcode agent-specific behaviour", async () => {
    h = createHarness();
    const client = await h.connect();
    for (const name of ["smart_home_assistant", "home_status_summary"]) {
      const p = await client.getPrompt({ name, arguments: {} });
      expect(JSON.stringify(p)).not.toMatch(/claude|agno|gpt|anthropic|openai/i);
    }
  });

  it("rejects missing or oversized prompt arguments", async () => {
    h = createHarness();
    const client = await h.connect();
    await expect(client.getPrompt({ name: "device_diagnostics", arguments: {} })).rejects.toThrow();
    await expect(client.getPrompt({ name: "device_diagnostics", arguments: { device: "x".repeat(500) } })).rejects.toThrow();
  });
});
