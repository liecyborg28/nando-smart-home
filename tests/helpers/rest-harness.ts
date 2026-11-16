import { parseEnv } from "@/config/env";
import { createLogger } from "@/lib/logger";
import type { PipelineDeps } from "@/http/pipeline";
import { createRestApi, type RestApi } from "@/rest/api";
import type { SmartHomeProvider } from "@/providers/provider.interface";
import type { AuditEntry, AuditLog } from "@/security/audit";
import { TokenAuthenticator } from "@/security/authentication";
import { InMemoryTokenStore } from "@/security/in-memory-token-store";
import { ConcurrencyLimiter, FixedWindowRateLimiter } from "@/security/rate-limit";
import { hashSecret } from "@/security/token-store";
import { createServices } from "@/services/container";
import type { ControlDeps } from "@/services/control.service";
import { READ_ID, READ_KEY, READ_NAME, WRITE_ID, WRITE_KEY, WRITE_NAME, fakeProvider } from "./mcp-harness";
import { testControlDeps } from "./smart-fleet";

export interface RestOptions {
  provider?: SmartHomeProvider;
  env?: Record<string, string | undefined>;
  rateLimit?: number;
  ipRateLimit?: number;
  maxConcurrent?: number;
  budget?: number;
  control?: ControlDeps;
  tokenCacheTtlMs?: number;
}

export interface CallInit {
  /** Token to send. `null` sends none. Defaults to the read token. */
  token?: string | null;
  headers?: Record<string, string>;
  /** Object is sent as JSON; a string is sent as is. */
  body?: unknown;
  /** Default `application/json` when a body is sent. */
  contentType?: string | null;
}

export interface RestResult {
  status: number;
  headers: Headers;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

type Handler = (req: Request, m: RegExpExecArray) => Promise<Response>;

/**
 * Drives the REST handlers the way Next.js would: it routes by method and path, decodes path
 * parameters, and answers 405 for a method a route does not export.
 */
export function createRestHarness(options: RestOptions = {}) {
  const env = parseEnv({ ...options.env });
  const store = new InMemoryTokenStore();
  store.seed({ id: READ_ID, name: READ_NAME, scopes: ["read"], secretHash: hashSecret("r".repeat(43)) });
  store.seed({ id: WRITE_ID, name: WRITE_NAME, scopes: ["read", "write"], secretHash: hashSecret("w".repeat(43)) });
  const authenticator = new TokenAuthenticator(store, { cacheTtlMs: options.tokenCacheTtlMs ?? 0 });

  const audit: AuditEntry[] = [];
  const auditLog: AuditLog = { record: (e) => void audit.push(e) };
  const logLines: string[] = [];

  const pipeline: PipelineDeps = {
    env,
    authenticator,
    logger: createLogger({ level: "debug", sink: (l) => logLines.push(l) }),
    ipLimiter: new FixedWindowRateLimiter(options.ipRateLimit ?? 100_000),
    failedAuthLimiter: new FixedWindowRateLimiter(20),
    limiter: new FixedWindowRateLimiter(options.rateLimit ?? 1000),
    concurrency: new ConcurrencyLimiter(options.maxConcurrent ?? 50),
  };
  const budget = options.budget ? new FixedWindowRateLimiter(options.budget) : undefined;
  const services = createServices(options.provider ?? fakeProvider(), options.control ?? testControlDeps());
  const api: RestApi = createRestApi({ pipeline, services: () => services, audit: auditLog, ...(budget ? { budget } : {}) });

  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/api\/devices$/, (r) => api.listDevices(r)],
    ["GET", /^\/api\/devices\/([^/]+)$/, (r, m) => api.getDevice(r, decodeURIComponent(m[1]!))],
    ["GET", /^\/api\/devices\/([^/]+)\/status$/, (r, m) => api.getDeviceStatus(r, decodeURIComponent(m[1]!))],
    ["GET", /^\/api\/devices\/([^/]+)\/capabilities$/, (r, m) => api.getDeviceCapabilities(r, decodeURIComponent(m[1]!))],
    ["POST", /^\/api\/devices\/([^/]+)\/commands$/, (r, m) => api.executeCommand(r, decodeURIComponent(m[1]!))],
    ["GET", /^\/api\/integrations\/tuya\/status$/, (r) => api.providerStatus(r)],
    ["OPTIONS", /^\/api\/(devices|integrations)(\/.*)?$/, (r) => api.preflight(r)],
  ];

  async function call(method: string, path: string, init: CallInit = {}): Promise<RestResult> {
    const headers = new Headers({ host: "localhost", ...init.headers });
    const token = init.token === undefined ? READ_KEY : init.token;
    if (token) headers.set("authorization", `Bearer ${token}`);
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
      if (init.contentType !== null) headers.set("content-type", init.contentType ?? "application/json");
    }
    const request = new Request(`http://localhost${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const pathname = new URL(request.url).pathname;
    const route = routes.find(([m, re]) => m === method && re.test(pathname));
    const response = route
      ? await route[2](request, route[1].exec(pathname)!)
      : new Response(null, { status: routes.some(([, re]) => re.test(pathname)) ? 405 : 404 }); // what Next answers
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  return {
    api,
    audit,
    logLines,
    store,
    services,
    pipeline,
    call,
    get: (path: string, init?: CallInit) => call("GET", path, init),
    post: (path: string, body: unknown, init: CallInit = {}) => call("POST", path, { token: WRITE_KEY, ...init, body }),
  };
}

export type RestHarness = ReturnType<typeof createRestHarness>;
