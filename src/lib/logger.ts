/**
 * Structured JSON logger with secret redaction.
 * Redaction is key-based and recursive, so credentials, tokens and signatures
 * are masked even when a caller logs a whole request/response object.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /secret|token|password|passwd|authorization|signature|^sign$|api[-_]?key|cookie|credential/i;
export const REDACTED = "[REDACTED]";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const TOKEN_PATTERN = /nsh_[a-f0-9]{16}\.[A-Za-z0-9_-]{20,}/g;
const DB_URL_PATTERN = /postgres(?:ql)?:\/\/[^\s"'\\]+/g;

/**
 * Key-name redaction misses secrets that appear inside free text (an error message, a URL).
 * This pass runs over the final line: it removes token-shaped strings, database URLs, and any
 * configured secret value, wherever they occur.
 */
export function scrub(line: string, secrets: readonly string[] = []): string {
  let out = line.replace(TOKEN_PATTERN, "nsh_[REDACTED]").replace(DB_URL_PATTERN, "postgres://[REDACTED]");
  for (const secret of secrets) {
    // Very short values would shred ordinary text; real secrets are long.
    if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

type Sink = (line: string) => void;

export function createLogger(
  options: { level?: LogLevel; bindings?: Record<string, unknown>; sink?: Sink; secrets?: readonly string[] } = {},
): Logger {
  const level = options.level ?? "info";
  const bindings = options.bindings ?? {};
  // stderr keeps stdout clean for the future STDIO MCP transport.
  const sink: Sink = options.sink ?? ((line) => process.stderr.write(line + "\n"));
  const secrets = options.secrets ?? [];

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const record = redact({ time: new Date().toISOString(), level: lvl, msg, ...bindings, ...fields });
    sink(scrub(JSON.stringify(record), secrets));
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger({ level, bindings: { ...bindings, ...b }, sink, secrets }),
  };
}
