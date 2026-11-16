import type { CallToolResult } from "@modelcontextprotocol/server";
import { toSafeError } from "@/core/errors";

import { UNTRUSTED_NOTICE } from "@/security/untrusted";

export { UNTRUSTED_NOTICE };

export function ok<T extends Record<string, unknown>>(data: T, summary: string): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n${UNTRUSTED_NOTICE}\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

/** Errors are returned as tool results (isError) so the model can read and react to them. */
export function failure(error: unknown): CallToolResult {
  const safe = toSafeError(error);
  return {
    isError: true,
    content: [{ type: "text", text: `Error ${safe.code}: ${safe.message}${safe.retryable ? " (retryable)" : ""}\n${JSON.stringify({ error: safe })}` }],
  };
}
