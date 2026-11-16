import { McpServer } from "@modelcontextprotocol/server";
import type { McpDeps } from "./guard";
import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { registerTools } from "./tools";

export const SERVER_INFO = {
  name: "nando-smart-home",
  version: "0.1.0",
  title: "Nando Smart Home",
  description: "Provider-independent smart home integration: inspect and (in later phases) control devices.",
} as const;

/**
 * Builds one McpServer. The HTTP handler calls this once per request (stateless
 * serving), so it must stay cheap and hold no per-connection state: all state
 * lives in the application services behind `deps`.
 */
export function createSmartHomeMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server);
  return server;
}
