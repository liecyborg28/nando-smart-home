import { handleMcp } from "@/mcp/app";

// The MCP SDK and node:crypto need the Node.js runtime, not the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Tuya calls take a few seconds at most; fail rather than hang a serverless invocation.
export const maxDuration = 30;

// Streamable HTTP endpoint. All HTTP methods go through the same pipeline; the SDK
// decides what each supports (e.g. stateless serving answers GET/DELETE with 405).
export const POST = (request: Request) => handleMcp(request);
export const GET = (request: Request) => handleMcp(request);
export const DELETE = (request: Request) => handleMcp(request);
