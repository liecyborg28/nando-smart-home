import { validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";
import { httpsRequired, type Env } from "@/config/env";
import type { ErrorCode } from "@/core/errors";
import type { Logger } from "@/lib/logger";
import type { Principal, TokenAuthenticator } from "@/security/authentication";
import { secureResponse } from "@/security/http-headers";
import type { ConcurrencyLimiter, FixedWindowRateLimiter } from "@/security/rate-limit";
import { isDirectLocalRequest, requestMeta, requestProtocol, type RequestMeta } from "@/security/request-context";

/**
 * The request pipeline shared by every machine-facing endpoint (/mcp and /api/*):
 *
 *   per-IP limit -> HTTPS -> Host/Origin allowlist (+ CORS preflight) -> token authentication
 *   -> per-token limit and concurrency -> the endpoint's own handler
 *
 * Keeping it in one place means a fix or a new protection applies to REST and MCP alike.
 * Scope checks, budgets and audit stay with the endpoint, which knows what the call costs.
 */

export interface PipelineDeps {
  env: Env;
  authenticator: Pick<TokenAuthenticator, "authenticate">;
  /** Per client IP, counted before authentication so floods are cheap to refuse. */
  ipLimiter: FixedWindowRateLimiter;
  /** Per client IP, failed authentications only (throttles token guessing and log/database load). */
  failedAuthLimiter: FixedWindowRateLimiter;
  /** Per authenticated token. */
  limiter: FixedWindowRateLimiter;
  /** Simultaneous in-flight requests per token. */
  concurrency: ConcurrencyLimiter;
  logger: Logger;
  /**
   * Called once at the start of every request. Production wires it to the platform's "keep alive until
   * background work (audit writes) is done" hook; tests leave it out.
   */
  afterResponse?: () => void;
}

export interface PipelineOptions {
  /** Answer CORS preflights and add CORS headers for allowlisted origins (REST for browser dashboards). */
  cors?: boolean;
}

export interface PipelineContext {
  principal: Principal;
  meta: RequestMeta;
}

export function errorResponse(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message, retryable: status === 429 || status === 503 } }, { status, headers });
}

const list = (csv: string): string[] => csv.split(",").map((s) => s.trim()).filter(Boolean);

const CORS_METHODS = "GET, POST, OPTIONS";
const CORS_ALLOW_HEADERS = "Authorization, Content-Type";

export async function runPipeline(
  request: Request,
  deps: PipelineDeps,
  options: PipelineOptions,
  handle: (ctx: PipelineContext) => Promise<Response>,
): Promise<Response> {
  const { env, logger } = deps;
  deps.afterResponse?.();
  const hops = env.TRUSTED_PROXY_HOPS;
  const meta = requestMeta(request, hops);
  const log = logger.child({ requestId: meta.requestId, clientIp: meta.clientIp });
  const requireHttps = httpsRequired(env);

  // The Origin header is only ever echoed back when it is on the allowlist (never "*", never reflected blindly).
  const origin = request.headers.get("origin");
  const originAllowed = origin !== null && validateOriginHeader(origin, list(env.MCP_ALLOWED_ORIGINS)).ok;
  const corsHeaders: Record<string, string> =
    options.cors && originAllowed ? { "Access-Control-Allow-Origin": origin!, Vary: "Origin", "Access-Control-Expose-Headers": "X-Request-Id, Retry-After" } : {};

  const secure = (res: Response): Response => {
    const out = secureResponse(res, { requestId: meta.requestId, hsts: requireHttps || requestProtocol(request, hops) === "https" });
    for (const [k, v] of Object.entries(corsHeaders)) out.headers.set(k, v);
    return out;
  };

  const ip = deps.ipLimiter.hit(meta.clientIp);
  if (!ip.allowed) {
    log.warn("request refused: per-IP rate limit");
    return secure(errorResponse(429, "PROVIDER_RATE_LIMITED", "Too many requests. Try again later.", { "Retry-After": String(ip.retryAfterSeconds) }));
  }

  if (requireHttps && requestProtocol(request, hops) !== "https" && !isDirectLocalRequest(request, hops)) {
    log.warn("request refused: plain HTTP");
    // Never redirect: a redirected POST would already have exposed the token in clear text.
    return secure(errorResponse(403, "AUTHORIZATION_FAILED", "HTTPS is required."));
  }

  const hostOk = validateHostHeader(request.headers.get("host"), list(env.MCP_ALLOWED_HOSTS)).ok;
  const originOk = origin === null || originAllowed; // no Origin = not a browser, nothing to defend against here
  if (!hostOk || !originOk) {
    log.warn("request rejected by host/origin check");
    return secure(errorResponse(403, "AUTHORIZATION_FAILED", "Host or origin not allowed."));
  }

  // CORS preflight: browsers send it WITHOUT credentials, so it is answered before authentication.
  if (options.cors && request.method === "OPTIONS") {
    if (!originAllowed) return secure(errorResponse(403, "AUTHORIZATION_FAILED", "Origin not allowed."));
    return secure(new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": CORS_METHODS, "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS, "Access-Control-Max-Age": "600" } }));
  }

  const auth = await deps.authenticator.authenticate(request);
  if (!auth.ok && auth.reason === "store_unavailable") {
    // Fail closed: if tokens cannot be verified, nothing is served.
    log.error("token store unavailable; refusing request");
    return secure(errorResponse(503, "PROVIDER_UNAVAILABLE", "Authentication is temporarily unavailable. Try again shortly.", { "Retry-After": "5" }));
  }
  if (!auth.ok) {
    const hit = deps.failedAuthLimiter.hit(meta.clientIp);
    log.warn("authentication failed", { reason: auth.reason });
    if (!hit.allowed) {
      return secure(errorResponse(429, "PROVIDER_RATE_LIMITED", "Too many failed attempts. Try again later.", { "Retry-After": String(hit.retryAfterSeconds) }));
    }
    // One uniform answer for every failure reason (unknown, revoked, expired, ...): nothing to learn from it.
    return secure(errorResponse(401, "AUTHENTICATION_FAILED", "Missing or invalid token.", { "WWW-Authenticate": 'Bearer realm="nando-smart-home"' }));
  }
  const principal = auth.principal;

  const limit = deps.limiter.hit(principal.id);
  if (!limit.allowed) {
    return secure(errorResponse(429, "PROVIDER_RATE_LIMITED", "Rate limit exceeded. Try again later.", { "Retry-After": String(limit.retryAfterSeconds) }));
  }

  const release = deps.concurrency.acquire(principal.id);
  if (!release) {
    return secure(errorResponse(429, "PROVIDER_RATE_LIMITED", "Too many simultaneous requests for this token.", { "Retry-After": "1" }));
  }

  try {
    return secure(await handle({ principal, meta }));
  } catch (error) {
    log.error("request handler failed", { error });
    return secure(errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred."));
  } finally {
    release();
  }
}
