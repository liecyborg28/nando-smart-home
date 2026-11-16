import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { parseEnv, type Env } from "@/config/env";
import type { DeviceCapability, DeviceStatus, SmartHomeDevice } from "@/core/domain";
import { AppError } from "@/core/errors";
import { createLogger } from "@/lib/logger";
import { handleMcpRequest, type McpHttpDeps } from "@/mcp/http";
import { MCP_HANDLER_LIMITS } from "@/mcp/limits";
import { createSmartHomeMcpServer } from "@/mcp/server";
import type { SmartHomeProvider } from "@/providers/provider.interface";
import type { AuditEntry, AuditLog } from "@/security/audit";
import { TokenAuthenticator } from "@/security/authentication";
import { InMemoryTokenStore } from "@/security/in-memory-token-store";
import { ConcurrencyLimiter, FixedWindowRateLimiter } from "@/security/rate-limit";
import { hashSecret } from "@/security/token-store";
import { createServices } from "@/services/container";
import type { ControlDeps } from "@/services/control.service";
import { testControlDeps } from "./smart-fleet";

// Deterministic, well-formed tokens: nsh_<16 hex>.<43 base64url chars>.
export const READ_ID = "1111111111111111";
export const WRITE_ID = "2222222222222222";
const READ_SECRET = "r".repeat(43);
const WRITE_SECRET = "w".repeat(43);
export const READ_KEY = `nsh_${READ_ID}.${READ_SECRET}`;
export const WRITE_KEY = `nsh_${WRITE_ID}.${WRITE_SECRET}`;
export const READ_NAME = "test-read";
export const WRITE_NAME = "test-write";

export const device = (
  id: string,
  kind: SmartHomeDevice["category"]["kind"],
  online: boolean,
  name = `Device ${id}`,
  providerCode: string = kind,
): SmartHomeDevice => ({
  id,
  provider: "tuya",
  name,
  category: { kind, providerCode },
  online,
  isSubDevice: false,
});

export const defaultFleet = [
  device("ac1", "climate", true, "Living room AC", "infrared_ac"),
  device("hub1", "remote", true, "IR hub", "wnykq"),
];

export function fakeProvider(devices: SmartHomeDevice[] = defaultFleet, overrides: Partial<SmartHomeProvider> = {}): SmartHomeProvider {
  const find = (id: string) => {
    const d = devices.find((x) => x.id === id);
    if (!d) throw new AppError("DEVICE_NOT_FOUND", "Device not found.");
    return d;
  };
  return {
    id: "tuya",
    checkConnection: async () => ({ provider: "tuya", connected: true }),
    listDevices: async () => devices,
    getDevice: async (id) => find(id),
    getDeviceStatus: async (id): Promise<DeviceStatus> => ({
      deviceId: find(id).id,
      online: find(id).online,
      properties: [{ code: "power", value: "1" }],
      retrievedAt: "2026-11-15T00:00:00.000Z",
    }),
    getDeviceCapabilities: async (id): Promise<DeviceCapability[]> => {
      if (find(id).category.providerCode === "wnykq") throw new AppError("UNSUPPORTED_OPERATION", "The device does not support this operation.");
      return [{ code: "T", kind: "enum", access: "write", constraints: { min: 16, max: 30 } }];
    },
    sendCommands: async () => {},
    ...overrides,
  };
}

export interface Harness {
  deps: McpHttpDeps;
  audit: AuditEntry[];
  store: InMemoryTokenStore;
  authenticator: TokenAuthenticator;
  /** Raw HTTP entry (full pipeline) for security tests. */
  http: (path: string, init?: RequestInit) => Promise<Response>;
  connect: (key?: string) => Promise<Client>;
  close: () => Promise<void>;
}

export function createHarness(
  options: { provider?: SmartHomeProvider; env?: Record<string, string | undefined>; rateLimit?: number; control?: ControlDeps; tokenCacheTtlMs?: number; controlEnabled?: boolean; ipRateLimit?: number; maxConcurrent?: number; budget?: number } = {},
): Harness {
  const env: Env = parseEnv({ ...options.env });
  const store = new InMemoryTokenStore();
  store.seed({ id: READ_ID, name: READ_NAME, scopes: ["read"], secretHash: hashSecret(READ_SECRET) });
  store.seed({ id: WRITE_ID, name: WRITE_NAME, scopes: ["read", "write"], secretHash: hashSecret(WRITE_SECRET) });
  const authenticator = new TokenAuthenticator(store, { cacheTtlMs: options.tokenCacheTtlMs ?? 0 });
  const audit: AuditEntry[] = [];
  const auditLog: AuditLog = { record: (e) => void audit.push(e) };
  // Created ONCE: the server factory below runs per request, and limiter state must outlive a request.
  const budget = options.budget ? new FixedWindowRateLimiter(options.budget) : undefined;
  const services = createServices(options.provider ?? fakeProvider(), options.control ?? testControlDeps());
  const handler = createMcpHandler(() => createSmartHomeMcpServer({ services: () => services, audit: auditLog, controlEnabled: options.controlEnabled ?? true, ...(budget ? { budget } : {}) }), { legacy: "stateless", ...MCP_HANDLER_LIMITS });
  const deps: McpHttpDeps = {
    env,
    handler,
    authenticator,
    logger: createLogger({ level: "error", sink: () => {} }),
    ipLimiter: new FixedWindowRateLimiter(options.ipRateLimit ?? 100_000),
    concurrency: new ConcurrencyLimiter(options.maxConcurrent ?? 50),
    limiter: new FixedWindowRateLimiter(options.rateLimit ?? 1000),
    failedAuthLimiter: new FixedWindowRateLimiter(20),
  };

  // In-process requests carry no Host header; a real HTTP server always does.
  const http = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", "localhost");
    return handleMcpRequest(new Request(`http://localhost${path}`, { ...init, headers }), deps);
  };

  const clients: Client[] = [];
  const connect = async (key: string = READ_KEY) => {
    const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => http(new URL(String(url)).pathname, init),
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  };

  return {
    deps,
    audit,
    store,
    authenticator,
    http,
    connect,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await handler.close();
    },
  };
}
