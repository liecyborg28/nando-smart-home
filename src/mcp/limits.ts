/**
 * Transport limits for the MCP handler. Shared by the real composition root and the tests
 * so the tested limits are the shipped limits.
 */
export const MCP_HANDLER_LIMITS = {
  /** MCP requests are small JSON-RPC messages; the SDK default of 4 MiB is needlessly generous. */
  maxRequestBodySize: 64 * 1024,
  /** Long-lived `subscriptions/listen` streams each hold a connection; this server has little use for them. */
  maxSubscriptions: 8,
} as const;
