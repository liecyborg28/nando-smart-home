import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { runPipeline, type PipelineDeps } from "@/http/pipeline";
import { toAuthInfo } from "@/security/authorization";

export interface McpHttpDeps extends PipelineDeps {
  handler: Pick<McpHttpHandler, "fetch">;
}

/**
 * The /mcp endpoint: the shared request pipeline (see src/http/pipeline.ts), then the MCP SDK.
 * The SDK handler never verifies credentials itself; it only receives the authInfo built from
 * the authenticated token, which tools then re-check per scope. Browsers get no CORS headers:
 * /mcp is for agents, not web pages.
 */
export function handleMcpRequest(request: Request, deps: McpHttpDeps): Promise<Response> {
  return runPipeline(request, deps, {}, ({ principal, meta }) => deps.handler.fetch(request, { authInfo: toAuthInfo(principal, meta) }));
}
