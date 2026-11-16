import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServices } from "@/services/container";
import { toAuthInfo } from "@/security/authorization";
import { ConfirmationManager, createConfirmationPolicy } from "@/security/confirmation";
import { createSmartHomeMcpServer } from "@/mcp/server";
import { createFakeHome } from "./fleet";
import { SCENARIOS } from "./scenarios";

/**
 * Mock smart home for skill evaluations.
 *   npx tsx evals/mock-home/server.ts --scenario door-lock --port 4101 --sent-log path/sent.jsonl
 *
 * It runs the REAL MCP tools, services, confirmation flow and verification over a fake,
 * stateful home. It always acts as a write-capable client: the point is to test the
 * agent's behaviour, not authentication (that is covered by the main test suite).
 */
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const scenario = arg("scenario") ?? "";
const port = Number(arg("port") ?? 4101);
const sentLog = arg("sent-log");
const defs = SCENARIOS[scenario];
if (!defs) {
  console.error(`Unknown scenario "${scenario}". Available: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}

const home = createFakeHome(defs);
if (sentLog) writeFileSync(sentLog, "");

// Ground truth for grading: every command the (fake) provider really accepted.
const recording = {
  ...home.provider,
  sendCommands: async (id: string, commands: { code: string; value: unknown }[]) => {
    if (sentLog) appendFileSync(sentLog, JSON.stringify({ at: new Date().toISOString(), deviceId: id, commands }) + "\n");
    return home.provider.sendCommands(id, commands as never);
  },
};

const services = createServices(recording, {
  confirmations: new ConfirmationManager("mock-home-confirmation-secret-0123456789"),
  policy: createConfirmationPolicy({ categories: ["ms"], confirmAll: false }),
  sleep: async () => {},
  verifyDelaysMs: [0],
});

const audit = { record: () => {} };
const handler = createMcpHandler(() => createSmartHomeMcpServer({ services: () => services, audit }), { legacy: "stateless" });
const authInfo = toAuthInfo({ id: "0000000000000000", name: "eval-agent", scopes: ["smarthome:read", "smarthome:write"] });

const server = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) });
    const response = await handler.fetch(request, { authInfo });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body as never).pipe(res);
    else res.end();
  } catch (error) {
    res.writeHead(500).end(String((error as Error).message));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`mock home "${scenario}" on http://127.0.0.1:${port}/mcp`));
