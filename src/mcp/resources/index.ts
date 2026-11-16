import {
  INTERNAL_ERROR,
  INVALID_REQUEST,
  ProtocolError,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { AppError, toSafeError } from "@/core/errors";
import { SCOPES } from "@/security/authentication";
import { actorNameOf, actorOf, requestMetaOf, requireScope } from "@/security/authorization";
import type { Services } from "@/services/container";
import { UNTRUSTED_NOTICE } from "../format";
import { chargeBudget, type McpDeps } from "../guard";

/**
 * Read-only resources. Same rules as tools: read scope required, audited, and
 * errors translated to protocol errors without leaking internals.
 */

function toProtocolError(uri: URL, error: unknown): Error {
  if (error instanceof AppError) {
    if (error.code === "DEVICE_NOT_FOUND") return new ResourceNotFoundError(uri.href);
    const safe = error.toSafe();
    return new ProtocolError(error.code === "AUTHORIZATION_FAILED" ? INVALID_REQUEST : INTERNAL_ERROR, safe.message, { error: safe });
  }
  return new ProtocolError(INTERNAL_ERROR, toSafeError(error).message);
}

async function read(
  deps: McpDeps,
  ctx: ServerContext,
  uri: URL,
  deviceIds: string[],
  load: (s: Services) => Promise<unknown>,
  cost = 1,
): Promise<ReadResourceResult> {
  const authInfo = ctx.http?.authInfo;
  const base = { actor: actorOf(authInfo), ...(actorNameOf(authInfo) ? { actorName: actorNameOf(authInfo) } : {}), ...requestMetaOf(authInfo), action: `resource:${uri.href}`, write: false, ...(deviceIds.length ? { deviceIds } : {}) };
  try {
    requireScope(authInfo, SCOPES.read);
    chargeBudget(deps, base.actor, cost);
    const data = await load(deps.services());
    deps.audit.record({ ...base, outcome: "success" });
    return {
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ notice: UNTRUSTED_NOTICE, data }) }],
    };
  } catch (error) {
    deps.audit.record({
      ...base,
      outcome: error instanceof AppError && error.code === "AUTHORIZATION_FAILED" ? "denied" : "failure",
      errorCode: error instanceof AppError ? error.code : "INTERNAL_ERROR",
    });
    throw toProtocolError(uri, error);
  }
}

// The catalog reads one specification per device (up to 50), so it is charged accordingly.
const CATALOG_COST = 25;

const variable = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

export function registerResources(server: McpServer, deps: McpDeps): void {
  const json = { mimeType: "application/json" };

  server.registerResource(
    "devices",
    "smarthome://devices",
    { title: "All devices", description: "Every linked device with id, name, category and online state.", ...json },
    (uri, ctx) => read(deps, ctx, uri, [], async (s) => ({ devices: await s.devices.listDevices() })),
  );

  server.registerResource(
    "overview",
    "smarthome://overview",
    { title: "Smart home overview", description: "Online/offline counts and a per-category summary of the home.", ...json },
    (uri, ctx) => read(deps, ctx, uri, [], (s) => s.status.getOverview()),
  );

  server.registerResource(
    "capabilities",
    "smarthome://capabilities",
    {
      title: "Capability catalog",
      description:
        "Capabilities of every device, taken from each device's own specification. Devices without a specification " +
        "(e.g. infrared hubs) carry an error entry instead. Reads one specification per device, so it can be slow.",
      ...json,
    },
    (uri, ctx) => read(deps, ctx, uri, [], (s) => s.capabilities.getCatalog(), CATALOG_COST),
  );

  const listDevices = async (ctx: ServerContext) => {
    try {
      requireScope(ctx.http?.authInfo, SCOPES.read);
      const devices = await deps.services().devices.listDevices();
      return { resources: devices.map((d) => ({ uri: `smarthome://devices/${d.id}`, name: d.name || d.id, mimeType: "application/json" })) };
    } catch (error) {
      // A failed listing must not break resources/list for the static resources.
      deps.audit.record({
        actor: actorOf(ctx.http?.authInfo),
        action: "resource:list smarthome://devices/{deviceId}",
        write: false,
        outcome: "failure",
        errorCode: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      });
      return { resources: [] };
    }
  };

  server.registerResource(
    "device",
    new ResourceTemplate("smarthome://devices/{deviceId}", { list: listDevices }),
    { title: "Device", description: "One device: name, category, product and online state.", ...json },
    (uri, vars, ctx) => {
      const id = variable(vars.deviceId);
      return read(deps, ctx, uri, [id], async (s) => ({ device: await s.devices.getDevice(id) }));
    },
  );

  server.registerResource(
    "device-status",
    new ResourceTemplate("smarthome://devices/{deviceId}/status", { list: undefined }),
    { title: "Device status", description: "Current status properties of one device.", ...json },
    (uri, vars, ctx) => {
      const id = variable(vars.deviceId);
      return read(deps, ctx, uri, [id], async (s) => ({ status: await s.status.getStatus(id) }), 2);
    },
  );
}
