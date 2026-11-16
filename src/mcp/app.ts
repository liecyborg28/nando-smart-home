import { createMcpHandler } from "@modelcontextprotocol/server";
import { toSafeError } from "@/core/errors";
import { getHttpContext } from "@/http/context";
import { getServices } from "@/services/container";
import { handleMcpRequest, type McpHttpDeps } from "./http";
import { MCP_HANDLER_LIMITS } from "./limits";
import { createSmartHomeMcpServer } from "./server";

/** Composition root for the /mcp route. Shares limiters, budget, audit and authentication with REST. */
const KEY = Symbol.for("nando-smart-home.mcp-app");
type Holder = { [KEY]?: McpHttpDeps };

function build(): McpHttpDeps {
  const ctx = getHttpContext();
  const controlEnabled = ctx.env.CONTROL_ENABLED === "true";
  const handler = createMcpHandler(
    () => createSmartHomeMcpServer({ services: getServices, audit: ctx.audit, controlEnabled, budget: ctx.budget }),
    {
      // Serves both 2026-07-28 clients and 2025-era clients (stateless), so Claude, Agno and the Inspector all connect.
      legacy: "stateless",
      ...MCP_HANDLER_LIMITS,
      onerror: (e) => ctx.logger.error("mcp transport error", { error: e }),
    },
  );
  return { ...ctx, handler };
}

export function getMcpDeps(): McpHttpDeps {
  const holder = globalThis as unknown as Holder;
  holder[KEY] ??= build();
  return holder[KEY];
}

export async function handleMcp(request: Request): Promise<Response> {
  try {
    return await handleMcpRequest(request, getMcpDeps());
  } catch (error) {
    // e.g. invalid environment configuration: report a safe error, never the details.
    const safe = toSafeError(error);
    return Response.json({ error: safe }, { status: 500 });
  }
}
