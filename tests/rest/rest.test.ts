import { describe, expect, it } from "vitest";
import { AppError } from "@/core/errors";
import { UNTRUSTED_NOTICE } from "@/security/untrusted";
import { WRITE_KEY, defaultFleet, device, fakeProvider } from "../helpers/mcp-harness";
import { createRestHarness } from "../helpers/rest-harness";
import { smartFleet, testControlDeps } from "../helpers/smart-fleet";

const fleet = () => smartFleet();

describe("GET /api/devices", () => {
  it("lists devices in the standard envelope, with the untrusted-data notice", async () => {
    const h = createRestHarness();
    const r = await h.get("/api/devices");
    expect(r.status).toBe(200);
    expect(r.json.data.count).toBe(2);
    expect(r.json.data.devices.map((d: { id: string }) => d.id)).toEqual(["ac1", "hub1"]);
    expect(r.json.notice).toBe(UNTRUSTED_NOTICE);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("filters by category, online state and combines filters", async () => {
    const h = createRestHarness({ provider: fakeProvider([...defaultFleet, device("l1", "light", false), device("l2", "light", true)]) });
    expect((await h.get("/api/devices?category=light")).json.data.count).toBe(2);
    expect((await h.get("/api/devices?category=light&online=true")).json.data.devices.map((d: { id: string }) => d.id)).toEqual(["l2"]);
    expect((await h.get("/api/devices?category=infrared_ac")).json.data.count).toBe(1);
    expect((await h.get("/api/devices?online=false")).json.data.count).toBe(1);
    expect((await h.get("/api/devices?room=bedroom")).json.data.count).toBe(0);
  });

  it.each([
    ["an unknown parameter", "/api/devices?colour=red"],
    ["a non-boolean online", "/api/devices?online=yes"],
    ["a repeated parameter", "/api/devices?category=a&category=b"],
    ["an oversized value", `/api/devices?category=${"x".repeat(51)}`],
  ])("rejects %s with 400 INVALID_REQUEST", async (_label, path) => {
    const r = await createRestHarness().get(path);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("INVALID_REQUEST");
  });
});

describe("GET /api/devices/{id} and friends", () => {
  it("returns one device, its status and its capabilities", async () => {
    const h = createRestHarness();
    expect((await h.get("/api/devices/ac1")).json.data.device).toMatchObject({ id: "ac1", provider: "tuya" });
    expect((await h.get("/api/devices/ac1/status")).json.data.status).toMatchObject({ deviceId: "ac1", online: true, properties: [{ code: "power", value: "1" }] });
    expect((await h.get("/api/devices/ac1/capabilities")).json.data).toMatchObject({ deviceId: "ac1", count: 1, capabilities: [{ code: "T", access: "write" }] });
  });

  it("answers 404 DEVICE_NOT_FOUND for an unknown id", async () => {
    const r = await createRestHarness().get("/api/devices/nope");
    expect(r.status).toBe(404);
    expect(r.json.error).toMatchObject({ code: "DEVICE_NOT_FOUND", retryable: false });
  });

  it.each([
    ["path traversal", "..%2F..%2Ftoken"],
    ["a query smuggled into the id", "a%3Fb%3D1"],
    ["a slash", "a%2Fb"],
    ["a space", "a%20b"],
    ["too long", "x".repeat(65)],
    ["a null byte", "a%00b"],
    ["script text", "%3Cscript%3E"],
  ])("answers 404 (not 500, not a provider call) for a malformed id: %s", async (_label, id) => {
    const h = createRestHarness();
    for (const suffix of ["", "/status", "/capabilities"]) {
      const r = await h.get(`/api/devices/${id}${suffix}`);
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("DEVICE_NOT_FOUND");
    }
  });

  it("explains a device without a specification as 422 UNSUPPORTED_OPERATION", async () => {
    const r = await createRestHarness().get("/api/devices/hub1/capabilities");
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("UNSUPPORTED_OPERATION");
  });

  it("rejects unexpected query parameters on device routes", async () => {
    expect((await createRestHarness().get("/api/devices/ac1?x=1")).status).toBe(400);
  });

  it("reports an offline device as data, not as an error", async () => {
    const h = createRestHarness({ provider: smartFleet().provider });
    const r = await h.get("/api/devices/lamp2/status");
    expect(r.status).toBe(200);
    expect(r.json.data.status.online).toBe(false);
  });

  it("answers 405 for a method the route does not export", async () => {
    const h = createRestHarness();
    expect((await h.call("DELETE", "/api/devices/ac1", { token: WRITE_KEY })).status).toBe(405);
    expect((await h.call("POST", "/api/devices", { token: WRITE_KEY, body: {} })).status).toBe(405);
    expect((await h.call("GET", "/api/devices/ac1/commands")).status).toBe(405);
  });
});

describe("POST /api/devices/{id}/commands", () => {
  const body = (commands: unknown, extra: Record<string, unknown> = {}) => ({ commands, ...extra });

  it("executes, verifies and reports a standard device", async () => {
    const f = fleet();
    const h = createRestHarness({ provider: f.provider });
    const r = await h.post("/api/devices/lamp/commands", body([{ code: "switch_led", value: true }]));
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: "executed", deviceId: "lamp", accepted: true, verification: { result: "confirmed" } });
    expect(f.sent).toEqual([{ deviceId: "lamp", commands: [{ code: "switch_led", value: true }] }]);
  });

  it("sends several commands in one request", async () => {
    const f = fleet();
    const r = await createRestHarness({ provider: f.provider }).post("/api/devices/lamp/commands", body([{ code: "switch_led", value: true }, { code: "bright_value", value: 300 }]));
    expect(r.json.data.verification.result).toBe("confirmed");
    expect(f.sent).toHaveLength(1);
  });

  it("is honest about infrared devices: accepted but not verifiable", async () => {
    const r = await createRestHarness({ provider: fleet().provider }).post("/api/devices/ir-ac/commands", body([{ code: "PowerOn", value: "PowerOn" }]));
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ accepted: true, verification: { result: "not_verifiable" } });
    expect(r.json.data.verification.note).toMatch(/no state feedback/i);
  });

  it("reports a mismatch when the device did not change", async () => {
    const r = await createRestHarness({ provider: smartFleet({ ignoreCommands: true }).provider }).post("/api/devices/lamp/commands", body([{ code: "switch_led", value: true }]));
    expect(r.status).toBe(200);
    expect(r.json.data.verification.result).toBe("mismatch");
  });

  it("answers 428 and sends nothing for a high-impact action; the confirmed repeat executes once", async () => {
    const f = fleet();
    const h = createRestHarness({ provider: f.provider });
    const first = await h.post("/api/devices/door/commands", body([{ code: "lock_motor_state", value: false }]));
    expect(first.status).toBe(428);
    expect(first.json.data.status).toBe("confirmation_required");
    expect(first.json.data.confirmation.instruction).toMatch(/Nothing was executed/);
    expect(f.sent).toEqual([]);

    const token = first.json.data.confirmation.token;
    const second = await h.post("/api/devices/door/commands", body([{ code: "lock_motor_state", value: false }], { confirmationToken: token }));
    expect(second.status).toBe(200);
    expect(second.json.data.verification.result).toBe("confirmed");
    expect(f.sent).toHaveLength(1);

    const replay = await h.post("/api/devices/door/commands", body([{ code: "lock_motor_state", value: false }], { confirmationToken: token }));
    expect(replay.status).toBe(403);
    expect(replay.json.error.code).toBe("AUTHORIZATION_FAILED");
    expect(f.sent).toHaveLength(1);
  });

  it("rejects a confirmation token used for a different action", async () => {
    const f = fleet();
    const h = createRestHarness({ provider: f.provider });
    const first = await h.post("/api/devices/door/commands", body([{ code: "lock_motor_state", value: false }]));
    const r = await h.post("/api/devices/door/commands", body([{ code: "lock_motor_state", value: true }], { confirmationToken: first.json.data.confirmation.token }));
    expect(r.status).toBe(403);
    expect(f.sent).toEqual([]);
  });

  it.each([
    ["an out-of-range value", "lamp", [{ code: "bright_value", value: 5 }], 400, "INVALID_DEVICE_COMMAND"],
    ["a wrong type", "lamp", [{ code: "switch_led", value: "on" }], 400, "INVALID_DEVICE_COMMAND"],
    ["duplicate codes", "lamp", [{ code: "switch_led", value: true }, { code: "switch_led", value: false }], 400, "INVALID_DEVICE_COMMAND"],
    ["a capability the device lacks", "lamp", [{ code: "colour_data", value: "x" }], 422, "UNSUPPORTED_OPERATION"],
    ["a read-only capability", "sensor", [{ code: "va_temperature", value: 1 }], 422, "UNSUPPORTED_OPERATION"],
    ["an offline device", "lamp2", [{ code: "switch_led", value: true }], 409, "DEVICE_OFFLINE"],
    ["an unknown device", "ghost", [{ code: "switch_led", value: true }], 404, "DEVICE_NOT_FOUND"],
  ])("refuses %s and sends nothing", async (_label, id, commands, status, code) => {
    const f = fleet();
    const r = await createRestHarness({ provider: f.provider }).post(`/api/devices/${id}/commands`, body(commands));
    expect(r.status).toBe(status);
    expect(r.json.error.code).toBe(code);
    expect(f.sent).toEqual([]);
  });

  it.each([
    ["no commands", { commands: [] }],
    ["too many commands", { commands: Array.from({ length: 11 }, (_, i) => ({ code: `c${i}`, value: 1 })) }],
    ["a missing commands field", {}],
    ["an extra top-level field", { commands: [{ code: "a", value: 1 }], force: true }],
    ["an extra command field", { commands: [{ code: "a", value: 1, raw: "x" }] }],
    ["an object value", { commands: [{ code: "a", value: { nested: 1 } }] }],
    ["a null value", { commands: [{ code: "a", value: null }] }],
    ["a malformed code", { commands: [{ code: "../x", value: 1 }] }],
    ["an oversized string value", { commands: [{ code: "a", value: "x".repeat(256) }] }],
    ["a non-finite number", { commands: [{ code: "a", value: 1e999 }] }],
    ["an oversized confirmation token", { commands: [{ code: "a", value: 1 }], confirmationToken: "x".repeat(1025) }],
    ["an array instead of an object", [1, 2, 3]],
  ])("rejects %s with 400 INVALID_REQUEST before touching the provider", async (_label, payload) => {
    const f = fleet();
    const r = await createRestHarness({ provider: f.provider }).post("/api/devices/lamp/commands", payload);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("INVALID_REQUEST");
    expect(f.sent).toEqual([]);
  });

  it("names the offending field without echoing its value", async () => {
    const r = await createRestHarness().post("/api/devices/lamp/commands", { commands: [{ code: "bad code ###", value: 1 }] });
    expect(r.json.error.context.fields).toContain("commands.0.code");
    expect(r.text).not.toContain("bad code ###");
  });

  it("answers 400 for invalid JSON, 415 for the wrong content type, 413 for a big body", async () => {
    const h = createRestHarness();
    expect((await h.post("/api/devices/lamp/commands", "{not json")).status).toBe(400);
    expect((await h.post("/api/devices/lamp/commands", '{"commands":[]}', { contentType: "text/plain" })).status).toBe(415);
    expect((await h.post("/api/devices/lamp/commands", '{"commands":[]}', { contentType: null })).status).toBe(415);
    const big = await h.post("/api/devices/lamp/commands", JSON.stringify({ commands: [{ code: "a", value: "x".repeat(70_000) }] }));
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("INVALID_REQUEST");
  });

  it("accepts a JSON content type with a charset", async () => {
    const f = fleet();
    const r = await createRestHarness({ provider: f.provider }).post("/api/devices/lamp/commands", { commands: [{ code: "switch_led", value: true }] }, { contentType: "application/json; charset=utf-8" });
    expect(r.status).toBe(200);
  });

  it("ignores query parameters it does not know (rejects them)", async () => {
    expect((await createRestHarness().call("POST", "/api/devices/lamp/commands?force=1", { token: WRITE_KEY, body: { commands: [{ code: "switch_led", value: true }] } })).status).toBe(400);
  });
});

describe("GET /api/integrations/tuya/status", () => {
  it("reports the connection", async () => {
    const r = await createRestHarness().get("/api/integrations/tuya/status");
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ provider: "tuya", connected: true });
  });

  it("reports a failed link as data (connected:false) with a safe error", async () => {
    const h = createRestHarness({
      provider: fakeProvider(undefined, {
        checkConnection: async () => {
          throw new AppError("PROVIDER_UNAVAILABLE", "Could not reach Tuya.", { context: { providerCode: 1004 } });
        },
      }),
    });
    const r = await h.get("/api/integrations/tuya/status");
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ provider: "tuya", connected: false, error: { code: "PROVIDER_UNAVAILABLE" } });
  });
});

describe("error mapping", () => {
  const failing = (error: unknown) => createRestHarness({ provider: fakeProvider(undefined, { listDevices: async () => Promise.reject(error) }) });

  it("never tells the caller THEIR token is wrong when the server's provider credentials fail", async () => {
    for (const code of ["AUTHENTICATION_FAILED", "TOKEN_EXPIRED"] as const) {
      const r = await failing(new AppError(code, "Tuya rejected the request credentials, signature or timestamp.", { context: { providerCode: 1004 } })).get("/api/devices");
      expect(r.status).toBe(502);
      expect(r.json.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(r.json.error.retryable).toBe(false);
      expect(r.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("maps provider rate limiting to 429 with Retry-After", async () => {
    const r = await failing(new AppError("PROVIDER_RATE_LIMITED", "Tuya rate limit reached.", { context: { retryAfterSeconds: 17 } })).get("/api/devices");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("17");
    expect(r.json.error.retryable).toBe(true);
  });

  it("maps timeouts to 504 and unexpected errors to a generic 500 that leaks nothing", async () => {
    expect((await failing(new AppError("REQUEST_TIMEOUT", "The request to Tuya timed out.")).get("/api/devices")).status).toBe(504);
    const r = await failing(new Error("db password=hunter2 failed at /srv/app/secret.ts")).get("/api/devices");
    expect(r.status).toBe(500);
    expect(r.json.error.code).toBe("INTERNAL_ERROR");
    expect(r.text).not.toMatch(/hunter2|secret\.ts/);
  });

  it("error responses use the same envelope and no notice", async () => {
    const r = await createRestHarness().get("/api/devices/nope");
    expect(Object.keys(r.json)).toEqual(["error"]);
    expect(Object.keys(r.json.error).sort()).toEqual(expect.arrayContaining(["code", "message", "retryable"]));
  });
});

describe("REST and MCP share one implementation", () => {
  it("control through REST uses the same confirmation policy and verification as MCP", async () => {
    const f = fleet();
    const h = createRestHarness({ provider: f.provider, control: testControlDeps() });
    // High impact is decided by the service, not by the route.
    expect((await h.post("/api/devices/door/commands", { commands: [{ code: "lock_motor_state", value: false }] })).status).toBe(428);
    expect((await h.post("/api/devices/ir-ac/commands", { commands: [{ code: "T", value: 99 }] })).status).toBe(400);
    expect(f.sent).toEqual([]);
  });

  it("REST lists exactly what the service layer lists", async () => {
    const h = createRestHarness({ provider: fleet().provider });
    const viaService = await h.services.devices.listDevices();
    const viaRest = (await h.get("/api/devices")).json.data.devices;
    expect(viaRest.map((d: { id: string }) => d.id)).toEqual(viaService.map((d) => d.id));
  });
});

void WRITE_KEY;
