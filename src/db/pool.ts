import { Pool } from "pg";

/**
 * Postgres access. Rules for everything that uses this pool:
 *  - queries are always parameterized (never string-built),
 *  - no named prepared statements (the pooled Neon endpoint runs PgBouncer in transaction mode),
 *  - connection strings and passwords are never logged.
 */

/**
 * `pg` currently treats sslmode=require as verify-full and warns that the meaning will
 * change to the weaker libpq behaviour in v9. Be explicit so certificate and hostname
 * verification stay on regardless of library version.
 */
export function normalizeDatabaseUrl(url: string): string {
  return url.replace(/([?&])sslmode=(require|prefer|verify-ca)(?=&|$)/, "$1sslmode=verify-full");
}

export interface PoolOptions {
  max?: number;
  /** Search path (schema) for every connection; used by tests to isolate their tables. */
  schema?: string;
}

export function createPool(url: string, options: PoolOptions = {}): Pool {
  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(url),
    max: options.max ?? 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    // A hung query must not hang a request: fail fast and let callers fail closed.
    statement_timeout: 5_000,
    query_timeout: 6_000,
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
  });
  // An idle client erroring (e.g. Neon suspending the compute) must not crash the process.
  pool.on("error", () => {});
  return pool;
}
