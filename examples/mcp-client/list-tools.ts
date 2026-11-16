/**
 * The smallest useful MCP client for Nando Smart Home: no framework, no language model.
 * Any MCP client does the same three things: connect with a bearer token, list tools, call one.
 *
 *   NANDO_TOKEN=nsh_... NANDO_MCP_URL=http://localhost:3000/mcp npx tsx examples/mcp-client/list-tools.ts
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.NANDO_MCP_URL ?? "http://localhost:3000/mcp";
const token = process.env.NANDO_TOKEN;
if (!token) {
  console.error("NANDO_TOKEN is not set. Create one with: npm run token -- create <name> --scope read");
  process.exit(2);
}

const client = new Client({ name: "nando-example-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`${tools.length} tools:`);
  for (const tool of tools) console.log(`  - ${tool.name}`);

  const result = await client.callTool({ name: "get_smart_home_overview", arguments: {} });
  const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
  console.log(`\nget_smart_home_overview${result.isError ? " (error)" : ""}:\n${text}`);
} catch (error) {
  // A rejected token or an unreachable server surfaces here. Never print the token.
  console.error(`Request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1; // let the event loop drain instead of process.exit(), which can crash on Windows
} finally {
  await client.close().catch(() => {});
}
