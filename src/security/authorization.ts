import type { AuthInfo } from "@modelcontextprotocol/server";
import { AppError } from "@/core/errors";
import type { Principal, Scope } from "./authentication";
import type { RequestMeta } from "./request-context";

/**
 * The MCP SDK passes `authInfo` through untouched (it verifies nothing), so the
 * HTTP layer builds it from an authenticated Principal and every tool/resource
 * re-checks the scope it needs. The raw token is never placed in AuthInfo.
 */
export function toAuthInfo(principal: Principal, meta?: RequestMeta): AuthInfo {
  return {
    token: "[redacted]",
    clientId: principal.id,
    scopes: [...principal.scopes],
    extra: { name: principal.name, ...(meta ? { requestId: meta.requestId, clientIp: meta.clientIp, userAgent: meta.userAgent } : {}) },
  };
}

export function requireScope(authInfo: AuthInfo | undefined, scope: Scope): AuthInfo {
  if (!authInfo?.scopes.includes(scope)) {
    throw new AppError("AUTHORIZATION_FAILED", "This token is not permitted to perform this operation.", {
      context: { requiredScope: scope },
    });
  }
  return authInfo;
}

/** The token id: the stable identity used for rate limits, confirmation binding and audit. */
export function actorOf(authInfo: AuthInfo | undefined): string {
  return authInfo?.clientId ?? "anonymous";
}

/** The operator-chosen token label, for human-readable audit entries. */
export function actorNameOf(authInfo: AuthInfo | undefined): string | undefined {
  const name = authInfo?.extra?.name;
  return typeof name === "string" ? name : undefined;
}

/** Request-scoped facts for audit entries (request id, client IP, user agent), when the pipeline supplied them. */
export function requestMetaOf(authInfo: AuthInfo | undefined): { requestId?: string; clientIp?: string; userAgent?: string } {
  const x = authInfo?.extra;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const out: { requestId?: string; clientIp?: string; userAgent?: string } = {};
  const requestId = str(x?.requestId);
  const clientIp = str(x?.clientIp);
  const userAgent = str(x?.userAgent);
  if (requestId) out.requestId = requestId;
  if (clientIp) out.clientIp = clientIp;
  if (userAgent) out.userAgent = userAgent;
  return out;
}
