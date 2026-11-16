import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SCOPES } from "@/security/authentication";
import { READ_ONLY, guarded, type McpDeps } from "../guard";

export function registerProviderTools(server: McpServer, deps: McpDeps): void {
  const input = z.object({});
  server.registerTool(
    "check_provider_connection",
    {
      title: "Check provider connection",
      description:
        "Verify that the server can reach the smart home provider (Tuya Cloud) and that its credentials are accepted. " +
        "Returns only connected/not connected; credentials and tokens are never exposed. Read-only.",
      inputSchema: input,
      outputSchema: z.object({ provider: z.string(), connected: z.boolean() }),
      annotations: { title: "Check provider connection", ...READ_ONLY },
    },
    guarded(deps, { name: "check_provider_connection", scope: SCOPES.read }, async (_args: z.infer<typeof input>, s) => {
      const status = await s.provider.checkConnection();
      return { data: { ...status }, summary: `Provider ${status.provider} is ${status.connected ? "connected" : "not connected"}.` };
    }),
  );
}
