import { appendFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/**
 * Tiny MCP client for the evaluation agents.
 *   npx tsx evals/mock-home/call.ts --port 4101 --list
 *   npx tsx evals/mock-home/call.ts --port 4101 list_devices '{}'
 *   npx tsx evals/mock-home/call.ts --port 4101 --log calls.jsonl turn_on_device '{"deviceId":"..."}'
 *
 * It prints what an MCP host would hand to a model: the text content of the result
 * and whether it is an error. Every call is also appended to --log for grading.
 */
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = flag("port");
const logPath = flag("log");
if (!port) {
  console.error("usage: call.ts --port N [--log file] (--list | <tool> [json-arguments])");
  process.exit(2);
}

// Positional args = everything that is not a flag or a flag's value.
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i]!.startsWith("--")) {
    if (argv[i] !== "--list") i++;
    continue;
  }
  positional.push(argv[i]!);
}

const client = new Client({ name: "eval-agent-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

try {
  if (argv.includes("--list")) {
    const { tools } = await client.listTools();
    for (const t of tools) {
      console.log(`## ${t.name}\n${t.description ?? ""}\ninput: ${JSON.stringify(t.inputSchema.properties ?? {})} required: ${JSON.stringify(t.inputSchema.required ?? [])}\n`);
    }
  } else {
    const [tool, rawArgs] = positional;
    if (!tool) throw new Error("missing tool name");
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      throw new Error("arguments must be valid JSON, e.g. '{\"deviceId\":\"abc\"}'");
    }
    const result = await client.callTool({ name: tool, arguments: args }).catch((e: unknown) => ({ isError: true, content: [{ type: "text", text: `Protocol error: ${(e as Error).message}` }] }));
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    console.log(`${result.isError ? "[tool returned an error]\n" : ""}${text}`);
    if (logPath) appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), tool, args, isError: Boolean(result.isError), text }) + "\n");
  }
} finally {
  await client.close();
}
