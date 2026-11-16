import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES } from "@/core/errors";
import { READ_KEY, WRITE_KEY, fakeProvider } from "../helpers/mcp-harness";
import { createRestHarness, type RestHarness } from "../helpers/rest-harness";
import { smartFleet } from "../helpers/smart-fleet";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = process.cwd();
const doc: any = YAML.parse(readFileSync(join(ROOT, "openapi.yaml"), "utf8"));
const METHODS = ["get", "post", "put", "patch", "delete"];

// ---------- helpers ----------
function deref(node: any): any {
  let n = node;
  while (n && typeof n === "object" && typeof n.$ref === "string") {
    n = n.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce((acc: any, key: string) => acc?.[key], doc);
  }
  return n;
}

/** Point every internal $ref at the registered document, and forbid undocumented fields on documented objects. */
function strictify(node: any): any {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === "$ref" && typeof v === "string" ? `spec${v}` : strictify(v);
  if (out.type === "object" && out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(doc, "spec");

function validateAgainst(schema: any, body: unknown): string[] {
  const validate = ajv.compile(strictify(schema));
  return validate(body) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
}

function responseSchema(method: string, pathTemplate: string, status: number): any | undefined {
  const response = deref(doc.paths[pathTemplate]?.[method.toLowerCase()]?.responses?.[String(status)]);
  return response?.content?.["application/json"]?.schema;
}

function operations(): Array<{ method: string; path: string; op: any }> {
  return Object.entries<any>(doc.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((m) => ({ method: m.toUpperCase(), path, op: item[m] })));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

function implementedRoutes(): string[] {
  return walk(join(ROOT, "src/app/api"))
    .flatMap((file) => {
      const rel = relative(join(ROOT, "src/app/api"), file).split("\\").join("/").replace(/\/?route\.ts$/, "").replace(/\[(\w+)\]/g, "{$1}");
      const path = "/api" + (rel ? `/${rel}` : "");
      const source = readFileSync(file, "utf8");
      const methods = [...source.matchAll(/export (?:async function|function|const) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!);
      return methods.map((m) => `${m} ${path}`);
    })
    .sort();
}

describe("OpenAPI document structure", () => {
  it("is OpenAPI 3.1 with a bearer security scheme and a server entry", () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.servers?.length).toBeGreaterThan(0);
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("documents exactly the routes that exist in src/app/api (no more, no fewer)", () => {
    const documented = operations().map((o) => `${o.method} ${o.path}`).sort();
    expect(documented).toEqual(implementedRoutes());
  });

  it("gives every operation a unique id, a summary and documented 429/401 behaviour (except the public health check)", () => {
    const ids = new Set<string>();
    for (const { method, path, op } of operations()) {
      expect(op.operationId, `${method} ${path}`).toBeTruthy();
      expect(ids.has(op.operationId), `duplicate ${op.operationId}`).toBe(false);
      ids.add(op.operationId);
      expect(op.summary, `${method} ${path}`).toBeTruthy();
      if (path !== "/api/health") {
        expect(op.responses["401"], `${method} ${path} 401`).toBeDefined();
        expect(op.responses["429"], `${method} ${path} 429`).toBeDefined();
        expect(op.security, `${method} ${path} must not opt out of authentication`).toBeUndefined();
      }
    }
  });

  it("resolves every $ref", () => {
    const missing: string[] = [];
    (function visit(node: any, where: string) {
      if (Array.isArray(node)) return node.forEach((v, i) => visit(v, `${where}[${i}]`));
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string" && deref({ $ref: v }) === undefined) missing.push(`${where} -> ${v}`);
        else visit(v, `${where}.${k}`);
      }
    })(doc, "doc");
    expect(missing).toEqual([]);
  });

  it("lists exactly the error codes the server can produce", () => {
    expect([...doc.components.schemas.ErrorCode.enum].sort()).toEqual([...ERROR_CODES].sort());
  });

  it("marks the write route as the only one that sends a body", () => {
    const withBody = operations().filter((o) => o.op.requestBody).map((o) => `${o.method} ${o.path}`);
    expect(withBody).toEqual(["POST /api/devices/{id}/commands"]);
  });

  it("has request examples that validate against their own schema", () => {
    const examples = doc.paths["/api/devices/{id}/commands"].post.requestBody.content["application/json"].examples;
    for (const [name, ex] of Object.entries<any>(examples)) {
      expect(validateAgainst({ $ref: "#/components/schemas/CommandRequest" }, ex.value), name).toEqual([]);
    }
  });

  it("rejects what the schema should reject (the schemas are not vacuous)", () => {
    const bad = (body: unknown) => validateAgainst({ $ref: "#/components/schemas/CommandRequest" }, body).length > 0;
    expect(bad({ commands: [] })).toBe(true);
    expect(bad({ commands: [{ code: "a", value: { x: 1 } }] })).toBe(true);
    expect(bad({ commands: [{ code: "a", value: 1 }], extra: 1 })).toBe(true);
    expect(bad({ commands: [{ code: "../x", value: 1 }] })).toBe(true);
    expect(validateAgainst({ $ref: "#/components/schemas/Device" }, { id: "x" }).length).toBeGreaterThan(0);
  });
});

describe("real responses match the document", () => {
  interface Case {
    label: string;
    method: string;
    template: string;
    run: (h: RestHarness) => Promise<{ status: number; json: unknown; text: string }>;
    harness?: () => RestHarness;
    expectStatus: number;
  }

  const fleet = () => createRestHarness({ provider: smartFleet().provider });
  const cmd = (id: string, commands: unknown, extra: Record<string, unknown> = {}) => (h: RestHarness) => h.post(`/api/devices/${id}/commands`, { commands, ...extra });

  const CASES: Case[] = [
    { label: "list", method: "GET", template: "/api/devices", expectStatus: 200, run: (h) => h.get("/api/devices") },
    { label: "list, empty", method: "GET", template: "/api/devices", expectStatus: 200, harness: () => createRestHarness({ provider: fakeProvider([]) }), run: (h) => h.get("/api/devices") },
    { label: "list, bad query", method: "GET", template: "/api/devices", expectStatus: 400, run: (h) => h.get("/api/devices?colour=red") },
    { label: "device", method: "GET", template: "/api/devices/{id}", expectStatus: 200, run: (h) => h.get("/api/devices/ir-ac") },
    { label: "device, unknown", method: "GET", template: "/api/devices/{id}", expectStatus: 404, run: (h) => h.get("/api/devices/ghost") },
    { label: "device, malformed id", method: "GET", template: "/api/devices/{id}", expectStatus: 404, run: (h) => h.get("/api/devices/..%2Fx") },
    { label: "status", method: "GET", template: "/api/devices/{id}/status", expectStatus: 200, run: (h) => h.get("/api/devices/lamp/status") },
    { label: "status, offline device", method: "GET", template: "/api/devices/{id}/status", expectStatus: 200, run: (h) => h.get("/api/devices/lamp2/status") },
    { label: "capabilities", method: "GET", template: "/api/devices/{id}/capabilities", expectStatus: 200, run: (h) => h.get("/api/devices/lamp/capabilities") },
    { label: "capabilities, IR device", method: "GET", template: "/api/devices/{id}/capabilities", expectStatus: 200, run: (h) => h.get("/api/devices/ir-ac/capabilities") },
    { label: "capabilities, no spec", method: "GET", template: "/api/devices/{id}/capabilities", expectStatus: 422, harness: () => createRestHarness(), run: (h) => h.get("/api/devices/hub1/capabilities") },
    { label: "command executed", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 200, run: cmd("lamp", [{ code: "switch_led", value: true }]) },
    { label: "command on IR (not verifiable)", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 200, run: cmd("ir-ac", [{ code: "PowerOn", value: "PowerOn" }]) },
    { label: "command mismatch", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 200, harness: () => createRestHarness({ provider: smartFleet({ ignoreCommands: true }).provider }), run: cmd("lamp", [{ code: "switch_led", value: true }]) },
    { label: "command needs confirmation", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 428, run: cmd("door", [{ code: "lock_motor_state", value: false }]) },
    { label: "command, invalid value", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 400, run: cmd("lamp", [{ code: "bright_value", value: 5 }]) },
    { label: "command, invalid body", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 400, run: cmd("lamp", []) },
    { label: "command, unknown device", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 404, run: cmd("ghost", [{ code: "a", value: 1 }]) },
    { label: "command, offline", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 409, run: cmd("lamp2", [{ code: "switch_led", value: true }]) },
    { label: "command, no such capability", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 422, run: cmd("lamp", [{ code: "colour_data", value: "x" }]) },
    { label: "command, too large", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 413, run: (h) => h.post("/api/devices/lamp/commands", JSON.stringify({ commands: [{ code: "a", value: "x".repeat(70_000) }] })) },
    { label: "command, wrong content type", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 415, run: (h) => h.post("/api/devices/lamp/commands", "{}", { contentType: "text/plain" }) },
    { label: "command, read token", method: "POST", template: "/api/devices/{id}/commands", expectStatus: 403, run: (h) => h.post("/api/devices/lamp/commands", { commands: [{ code: "switch_led", value: true }] }, { token: READ_KEY }) },
    { label: "provider status", method: "GET", template: "/api/integrations/tuya/status", expectStatus: 200, run: (h) => h.get("/api/integrations/tuya/status") },
    {
      label: "provider status, link broken",
      method: "GET",
      template: "/api/integrations/tuya/status",
      expectStatus: 200,
      harness: () => createRestHarness({ provider: fakeProvider(undefined, { checkConnection: async () => Promise.reject(new AppError("PROVIDER_UNAVAILABLE", "Could not reach Tuya.")) }) }),
      run: (h) => h.get("/api/integrations/tuya/status"),
    },
    { label: "no token", method: "GET", template: "/api/devices", expectStatus: 401, run: (h) => h.get("/api/devices", { token: null }) },
    { label: "rate limited", method: "GET", template: "/api/devices", expectStatus: 429, harness: () => createRestHarness({ rateLimit: 1 }), run: async (h) => (await h.get("/api/devices"), h.get("/api/devices")) },
    { label: "token store down", method: "GET", template: "/api/devices", expectStatus: 503, run: async (h) => ((h.store.failing = true), h.get("/api/devices")) },
    {
      label: "provider broken",
      method: "GET",
      template: "/api/devices",
      expectStatus: 502,
      harness: () => createRestHarness({ provider: fakeProvider(undefined, { listDevices: async () => Promise.reject(new AppError("AUTHENTICATION_FAILED", "Tuya rejected the request credentials.")) }) }),
      run: (h) => h.get("/api/devices"),
    },
  ];

  it.each(CASES)("$label ($method $template -> $expectStatus)", async (c) => {
    const h = c.harness ? c.harness() : fleet();
    const r = await c.run(h);
    expect(r.status).toBe(c.expectStatus);
    const schema = responseSchema(c.method, c.template, r.status);
    expect(schema, `${c.method} ${c.template} does not document status ${r.status}`).toBeDefined();
    expect(validateAgainst(schema, r.json), `${c.label}: ${r.text.slice(0, 200)}`).toEqual([]);
  });

  it("validates the health responses (anonymous and with a token)", () => {
    const schema = responseSchema("GET", "/api/health", 200);
    expect(validateAgainst(schema, { status: "ok", service: "nando-smart-home", time: new Date().toISOString() })).toEqual([]);
    expect(validateAgainst(schema, { status: "ok", service: "nando-smart-home", time: new Date().toISOString(), providers: { tuya: { configured: true } }, database: { configured: true }, control: { enabled: true } })).toEqual([]);
    expect(validateAgainst(schema, { status: "ok", service: "x", time: "not a date" }).length).toBeGreaterThan(0);
  });

  it("the write token response shapes are documented too (spot check with the write token)", async () => {
    const h = fleet();
    const r = await h.get("/api/devices", { token: WRITE_KEY });
    expect(validateAgainst(responseSchema("GET", "/api/devices", 200), r.json)).toEqual([]);
  });
});
