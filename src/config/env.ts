import { z } from "zod";

/**
 * Environment validation. Tuya credentials are optional here so the service
 * (and /api/health) can boot without them; code that needs them must call
 * requireTuyaConfig(), which fails with a safe error instead of a raw crash.
 */

// Only Tuya OpenAPI hosts over HTTPS are accepted: the base URL must never be
// steerable to an arbitrary server (SSRF / credential exfiltration).
const tuyaBaseUrl = z
  .url()
  .refine((u) => new URL(u).protocol === "https:", "must use https")
  .refine(
    (u) => /^openapi[a-z0-9-]*\.(tuya[a-z]{2}|iotbing)\.com$/.test(new URL(u).hostname),
    "must be a Tuya OpenAPI host (e.g. https://openapi-sg.iotbing.com)",
  );

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, value: z.output<T>) => z.preprocess(emptyToUndefined, schema.default(value as never));
const bool = z.enum(["true", "false"]);

// Messages deliberately never include the value: connection strings carry passwords.
const postgresUrl = z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection URL");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  TUYA_ACCESS_ID: optional(z.string().min(1)),
  TUYA_ACCESS_SECRET: optional(z.string().min(1)),
  TUYA_BASE_URL: withDefault(tuyaBaseUrl, "https://openapi-sg.iotbing.com"),
  TUYA_REQUEST_TIMEOUT_MS: withDefault(z.coerce.number().int().min(1000).max(60000), 10000),

  // --- Token store (Postgres) ---
  // DATABASE_URL: direct connection (migrations, token CLI). DATABASE_URL_POOLED: used by the running app.
  DATABASE_URL: optional(postgresUrl),
  DATABASE_URL_POOLED: optional(postgresUrl),
  // Seconds a verified token record is cached in-process; revocation takes effect within this time (0 = every request).
  TOKEN_CACHE_TTL_SECONDS: withDefault(z.coerce.number().int().min(0).max(300), 5),
  // Signs two-step confirmation tokens. Random, at least 32 characters.
  CONFIRMATION_SECRET: optional(z.string().min(32)),

  // --- Network exposure ---
  // Comma-separated hostnames (no ports) accepted in the Host header of /mcp and /api.
  // OPTIONAL: when unset or empty, every Host is accepted (the token is then the only gate).
  // Set it to your public hostname(s) to also defend against DNS rebinding.
  MCP_ALLOWED_HOSTS: optional(z.string()),
  // Comma-separated origins allowed for browsers (CORS). Always an explicit allowlist, never "any".
  MCP_ALLOWED_ORIGINS: withDefault(z.string(), "localhost,127.0.0.1,[::1]"),
  // Reject plain-HTTP requests (except localhost). Defaults to on in production.
  REQUIRE_HTTPS: optional(bool),
  // How many reverse proxies sit in front of the app. 0 = trust no X-Forwarded-* header.
  TRUSTED_PROXY_HOPS: withDefault(z.coerce.number().int().min(0).max(5), 0),

  // --- Limits ---
  // Usage budget per token per minute. Each tool/resource has a cost (batch reads and the capability
  // catalog cost more because they fan out into many provider calls), which protects the provider API quota.
  COST_BUDGET_PER_MINUTE: withDefault(z.coerce.number().int().min(1).max(1000000), 300),
  // Simultaneous in-flight requests allowed per token.
  MAX_CONCURRENT_PER_TOKEN: withDefault(z.coerce.number().int().min(1).max(100), 8),
  RATE_LIMIT_PER_MINUTE: withDefault(z.coerce.number().int().min(1).max(100000), 120),
  // Requests per minute per client IP, counted BEFORE authentication.
  IP_RATE_LIMIT_PER_MINUTE: withDefault(z.coerce.number().int().min(1).max(100000), 240),

  // --- Control (write) safety ---
  // "false" disables every control tool (emergency kill switch; takes effect after restart).
  CONTROL_ENABLED: withDefault(bool, "true"),
  WRITE_RATE_LIMIT_PER_MINUTE: withDefault(z.coerce.number().int().min(1).max(10000), 30),
  // Provider category codes treated as high impact (two-step confirmation). Best-effort defaults:
  // door locks, garage door openers and water valves. Extend for your own devices.
  HIGH_IMPACT_CATEGORIES: withDefault(z.string(), "ms,jtmspro,jtmsbh,ckmkzq,sfkzq"),
  // "true" requires confirmation for EVERY control action.
  CONFIRM_ALL_WRITES: withDefault(bool, "false"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Report variable names and reasons only, never the offending values.
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** For tests only. */
export function resetEnvCache(): void {
  cached = undefined;
}

export interface TuyaConfig {
  accessId: string;
  accessSecret: string;
  baseUrl: string;
  timeoutMs: number;
}

export function tuyaConfigFrom(env: Env): TuyaConfig | undefined {
  if (!env.TUYA_ACCESS_ID || !env.TUYA_ACCESS_SECRET) return undefined;
  return {
    accessId: env.TUYA_ACCESS_ID,
    accessSecret: env.TUYA_ACCESS_SECRET,
    baseUrl: env.TUYA_BASE_URL,
    timeoutMs: env.TUYA_REQUEST_TIMEOUT_MS,
  };
}

/** Plain HTTP is refused outside localhost unless explicitly turned off. Default: on in production. */
export function httpsRequired(env: Env): boolean {
  return env.REQUIRE_HTTPS ? env.REQUIRE_HTTPS === "true" : env.NODE_ENV === "production";
}

/**
 * Hostnames accepted in the Host header. An EMPTY list means the check is off and any Host is accepted;
 * the token remains the gate. Single source of truth for the pipeline and the startup warnings.
 */
export function allowedHosts(env: Pick<Env, "MCP_ALLOWED_HOSTS">): string[] {
  return (env.MCP_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
}

/** The database URL the running app should use: pooled when available. */
export function appDatabaseUrl(env: Env): string | undefined {
  return env.DATABASE_URL_POOLED ?? env.DATABASE_URL;
}

/** Every configured secret value, so the logger can scrub them from free text. */
export function secretValues(env: Env): string[] {
  const out: string[] = [];
  for (const v of [env.TUYA_ACCESS_SECRET, env.CONFIRMATION_SECRET]) if (v) out.push(v);
  for (const url of [env.DATABASE_URL, env.DATABASE_URL_POOLED]) {
    if (!url) continue;
    try {
      const password = decodeURIComponent(new URL(url).password);
      if (password) out.push(password);
    } catch {
      // A URL that does not parse has already been rejected by the schema.
    }
  }
  return out;
}
