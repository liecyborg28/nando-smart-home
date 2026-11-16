import { z } from "zod";
import { COMMAND_CODE_PATTERN } from "@/core/domain/command-validation";
import { MAX_COMMANDS_PER_CALL } from "@/core/domain";
import { AppError, type ErrorCode, type SafeError } from "@/core/errors";
import { errorResponse, runPipeline, type PipelineDeps } from "@/http/pipeline";
import type { AuditLog } from "@/security/audit";
import { SCOPES, type Principal, type Scope } from "@/security/authentication";
import { chargeBudget } from "@/security/budget";
import type { FixedWindowRateLimiter } from "@/security/rate-limit";
import type { RequestMeta } from "@/security/request-context";
import { UNTRUSTED_NOTICE } from "@/security/untrusted";
import type { Services } from "@/services/container";
import type { ControlResult } from "@/services/control.service";

/**
 * The REST API. Every route is a thin shell over the same application services the MCP tools use
 * (src/services), behind the same request pipeline (src/http/pipeline.ts): no business logic here,
 * only HTTP concerns: parsing, validation, status codes, error mapping, audit.
 */

export interface RestDeps {
  pipeline: PipelineDeps;
  services: () => Services;
  audit: AuditLog;
  /** Per-token usage budget, charged by cost (same budget as the MCP tools). */
  budget?: FixedWindowRateLimiter;
}

/** Relative provider cost of each call; matches the MCP tools so REST cannot dodge the budget. */
export const REST_COST = { list: 1, device: 1, status: 2, capabilities: 2, command: 6, provider: 1 } as const;

const MAX_BODY_BYTES = 64 * 1024;

interface Spec {
  /** Route template for audit and logs, e.g. "GET /api/devices/{id}/status". */
  name: string;
  scope: Scope;
  write?: boolean;
  cost: number;
  deviceId?: string;
}

interface Outcome {
  status?: number;
  data: unknown;
  auditNote?: string;
}

interface Call {
  principal: Principal;
  meta: RequestMeta;
  services: Services;
}

// ---------- request parsing ----------

function invalid(message: string, options: { fields?: string; httpStatus?: number } = {}): AppError {
  return new AppError("INVALID_REQUEST", message, {
    ...(options.fields ? { context: { fields: options.fields } } : {}),
    ...(options.httpStatus ? { httpStatus: options.httpStatus } : {}),
  });
}

/** Zod issues name the offending field and rule but never echo the value. */
function fromZod(error: z.ZodError): AppError {
  const issues = error.issues.slice(0, 5);
  const fields = issues.map((i) => i.path.join(".") || "(body)").join(",");
  return invalid(`Invalid request: ${issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ")}`, { fields });
}

function parseQuery<T extends z.ZodType>(request: Request, schema: T): z.output<T> {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    if (values.length > 1) throw invalid(`Query parameter "${key.slice(0, 40)}" must appear only once.`, { fields: key.slice(0, 40) });
    raw[key] = values[0]!;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw fromZod(parsed.error);
  return parsed.data;
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw invalid('Send the body as JSON with "Content-Type: application/json".', { httpStatus: 415 });
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw invalid(`The request body may be at most ${MAX_BODY_BYTES} bytes.`, { httpStatus: 413 });

  const reader = request.body?.getReader();
  if (!reader) throw invalid("The request needs a JSON body.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw invalid(`The request body may be at most ${MAX_BODY_BYTES} bytes.`, { httpStatus: 413 });
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("The request body is not valid JSON.");
  }
}

const listQuery = z.strictObject({
  category: z.string().max(50).optional(),
  room: z.string().max(50).optional(),
  online: z.enum(["true", "false"]).optional(),
});

const commandsBody = z.strictObject({
  commands: z
    .array(
      z.strictObject({
        code: z.string().regex(COMMAND_CODE_PATTERN, "must be a capability code from GET /api/devices/{id}/capabilities"),
        value: z.union([z.string().max(255), z.number().finite(), z.boolean()]),
      }),
    )
    .min(1)
    .max(MAX_COMMANDS_PER_CALL),
  confirmationToken: z.string().max(1024).optional(),
});

// ---------- response building ----------

/**
 * The service layer talks to the provider with the SERVER's credentials. If those fail, that is a
 * server-side problem: reporting 401 would make the caller think THEIR token is wrong.
 */
function forRest(error: AppError): AppError {
  if (error.code === "AUTHENTICATION_FAILED" || error.code === "TOKEN_EXPIRED") {
    return new AppError("PROVIDER_UNAVAILABLE", "The server's connection to the smart home provider needs attention.", { retryable: false });
  }
  return error;
}

function errorBody(error: AppError): Response {
  const safe: SafeError = error.toSafe();
  const retry: Record<string, string> = {};
  if (typeof error.context?.retryAfterSeconds === "number") retry["Retry-After"] = String(error.context.retryAfterSeconds);
  return Response.json({ error: safe }, { status: error.httpStatus, headers: retry });
}

function present(result: ControlResult): Outcome {
  const codes = result.commands.map((c) => c.code).join(",");
  if (result.status === "confirmation_required") {
    return {
      // 428 Precondition Required: nothing was executed. A client that only checks the status code cannot mistake this for success.
      status: 428,
      data: {
        status: result.status,
        deviceId: result.deviceId,
        commands: result.commands,
        confirmation: {
          ...result.confirmation,
          instruction: "Nothing was executed. Ask the user to explicitly confirm, then repeat this exact request with confirmationToken set to this token.",
        },
      },
      auditNote: `confirmation_required codes=${codes}`,
    };
  }
  return {
    data: { status: result.status, deviceId: result.deviceId, commands: result.commands, accepted: result.accepted, verification: result.verification },
    auditNote: `executed:${result.verification.result} codes=${codes}`,
  };
}

export function createRestApi(deps: RestDeps) {
  const { pipeline } = deps;

  function serve(request: Request, spec: Spec, run: (call: Call) => Promise<Outcome>): Promise<Response> {
    return runPipeline(request, pipeline, { cors: true }, async ({ principal, meta }) => {
      const base = {
        actor: principal.id,
        actorName: principal.name,
        action: `rest:${spec.name}`,
        write: spec.write ?? false,
        ...(spec.deviceId ? { deviceIds: [spec.deviceId.slice(0, 64)] } : {}),
        requestId: meta.requestId,
        clientIp: meta.clientIp,
        ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
      };
      try {
        if (!principal.scopes.includes(spec.scope)) {
          throw new AppError("AUTHORIZATION_FAILED", "This token is not permitted to perform this operation.", { context: { requiredScope: spec.scope } });
        }
        chargeBudget(deps.budget, principal.id, spec.cost);
        const outcome = await run({ principal, meta, services: deps.services() });
        deps.audit.record({ ...base, outcome: "success", ...(outcome.auditNote ? { note: outcome.auditNote } : {}) });
        return Response.json({ data: outcome.data, notice: UNTRUSTED_NOTICE }, { status: outcome.status ?? 200 });
      } catch (error) {
        if (!(error instanceof AppError)) {
          pipeline.logger.error("rest handler failed", { route: spec.name, error });
          deps.audit.record({ ...base, outcome: "failure", errorCode: "INTERNAL_ERROR" });
          return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred.");
        }
        const mapped = forRest(error);
        const denied = mapped.code === ("AUTHORIZATION_FAILED" satisfies ErrorCode);
        deps.audit.record({ ...base, outcome: denied ? "denied" : "failure", errorCode: mapped.code });
        return errorBody(mapped);
      }
    });
  }

  return {
    /** Answers CORS preflights (the pipeline does it) and refuses anything else sent to OPTIONS. */
    preflight: (request: Request) => runPipeline(request, pipeline, { cors: true }, async () => errorResponse(405, "INVALID_REQUEST", "Method not allowed.")),

    listDevices: (request: Request) =>
      serve(request, { name: "GET /api/devices", scope: SCOPES.read, cost: REST_COST.list }, async ({ services }) => {
        const q = parseQuery(request, listQuery);
        const devices = await services.devices.listDevices({
          ...(q.category ? { category: q.category } : {}),
          ...(q.room ? { room: q.room } : {}),
          ...(q.online ? { online: q.online === "true" } : {}),
        });
        return { data: { count: devices.length, devices } };
      }),

    getDevice: (request: Request, id: string) =>
      serve(request, { name: "GET /api/devices/{id}", scope: SCOPES.read, cost: REST_COST.device, deviceId: id }, async ({ services }) => {
        parseQuery(request, z.strictObject({}));
        return { data: { device: await services.devices.getDevice(id) } };
      }),

    getDeviceStatus: (request: Request, id: string) =>
      serve(request, { name: "GET /api/devices/{id}/status", scope: SCOPES.read, cost: REST_COST.status, deviceId: id }, async ({ services }) => {
        parseQuery(request, z.strictObject({}));
        return { data: { status: await services.status.getStatus(id) } };
      }),

    getDeviceCapabilities: (request: Request, id: string) =>
      serve(request, { name: "GET /api/devices/{id}/capabilities", scope: SCOPES.read, cost: REST_COST.capabilities, deviceId: id }, async ({ services }) => {
        parseQuery(request, z.strictObject({}));
        const capabilities = await services.capabilities.getCapabilities(id);
        return { data: { deviceId: id, count: capabilities.length, capabilities } };
      }),

    executeCommand: (request: Request, id: string) =>
      serve(request, { name: "POST /api/devices/{id}/commands", scope: SCOPES.write, write: true, cost: REST_COST.command, deviceId: id }, async ({ principal, services }) => {
        parseQuery(request, z.strictObject({}));
        const parsed = commandsBody.safeParse(await readJsonBody(request));
        if (!parsed.success) throw fromZod(parsed.error);
        const { commands, confirmationToken } = parsed.data;
        return present(await services.control.execute({ actor: principal.id }, id, commands, confirmationToken));
      }),

    /** Provider connectivity. A failed link is reported as data (connected:false), not as a failed request. */
    providerStatus: (request: Request) =>
      serve(request, { name: "GET /api/integrations/tuya/status", scope: SCOPES.read, cost: REST_COST.provider }, async ({ services }) => {
        parseQuery(request, z.strictObject({}));
        try {
          return { data: { ...(await services.provider.checkConnection()) } };
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          return { data: { provider: services.provider.id, connected: false, error: forRest(error).toSafe() } };
        }
      }),
  };
}

export type RestApi = ReturnType<typeof createRestApi>;
