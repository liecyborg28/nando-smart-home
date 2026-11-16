import { getEnv, secretValues, type Env } from "@/config/env";
import { getPool } from "@/db/runtime";
import { createLogger, type Logger } from "@/lib/logger";
import { createAuditLog, type AuditLog } from "@/security/audit";
import { TokenAuthenticator } from "@/security/authentication";
import { combineAuditLogs, createPostgresAuditLog } from "@/security/postgres-audit";
import { PostgresTokenStore } from "@/security/postgres-token-store";
import { ConcurrencyLimiter, FixedWindowRateLimiter } from "@/security/rate-limit";
import { UnavailableTokenStore } from "@/security/token-store";
import { afterResponse } from "./after-response";
import type { PipelineDeps } from "./pipeline";

/**
 * Everything the machine-facing endpoints (/mcp and /api/*) share: configuration, logger, token
 * authentication, limiters, usage budget and audit. Built once per process (kept on globalThis
 * so limiter state survives Next.js dev reloads) so REST and MCP draw from the same budgets.
 */
export interface HttpContext extends PipelineDeps {
  env: Env;
  logger: Logger;
  audit: AuditLog;
  /** Per-token usage budget, charged by cost. */
  budget: FixedWindowRateLimiter;
}

const KEY = Symbol.for("nando-smart-home.http-context");
type Holder = { [KEY]?: HttpContext };

const LOCAL_ONLY = new Set(["localhost", "127.0.0.1", "[::1]"]);

function warnAboutRiskyConfig(env: Env, log: Logger): void {
  const hosts = env.MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean);
  if (env.NODE_ENV === "production" && hosts.every((h) => LOCAL_ONLY.has(h))) {
    log.warn("MCP_ALLOWED_HOSTS only lists localhost: set your public hostname, otherwise remote clients are refused");
  }
  if (env.NODE_ENV === "production" && env.TRUSTED_PROXY_HOPS === 0) {
    log.warn("TRUSTED_PROXY_HOPS is 0: behind a TLS-terminating proxy every request looks like plain HTTP and per-IP limits share one bucket");
  }
  if (env.NODE_ENV === "production" && env.CONFIRM_ALL_WRITES !== "true") {
    log.warn("CONFIRM_ALL_WRITES is off: only high-impact devices need confirmation. Consider enabling it for a public deployment");
  }
  if (!env.CONFIRMATION_SECRET) {
    log.warn("CONFIRMATION_SECRET is not set: a random per-process secret is used, so confirmations do not survive a restart or span instances");
  }
}

function build(): HttpContext {
  const env = getEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, bindings: { service: "nando-smart-home" }, secrets: secretValues(env) });
  const pool = getPool(env);
  const audit = pool ? combineAuditLogs(createAuditLog(logger), createPostgresAuditLog(pool, logger)) : createAuditLog(logger);
  if (!pool) logger.error("No database configured (DATABASE_URL_POOLED): every authenticated request will be refused");
  warnAboutRiskyConfig(env, logger);

  return {
    env,
    logger,
    audit,
    afterResponse: () => afterResponse(() => audit.settled?.()),
    authenticator: new TokenAuthenticator(pool ? new PostgresTokenStore(pool) : new UnavailableTokenStore(), {
      cacheTtlMs: env.TOKEN_CACHE_TTL_SECONDS * 1000,
    }),
    ipLimiter: new FixedWindowRateLimiter(env.IP_RATE_LIMIT_PER_MINUTE),
    failedAuthLimiter: new FixedWindowRateLimiter(20),
    limiter: new FixedWindowRateLimiter(env.RATE_LIMIT_PER_MINUTE),
    concurrency: new ConcurrencyLimiter(env.MAX_CONCURRENT_PER_TOKEN),
    budget: new FixedWindowRateLimiter(env.COST_BUDGET_PER_MINUTE),
  };
}

export function getHttpContext(): HttpContext {
  const holder = globalThis as unknown as Holder;
  holder[KEY] ??= build();
  return holder[KEY];
}
