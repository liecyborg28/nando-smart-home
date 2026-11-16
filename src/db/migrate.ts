import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";

/**
 * Minimal forward-only migration runner. Each `db/migrations/NNN_name.sql` file is
 * applied once, inside a transaction, guarded by an advisory lock so two processes
 * cannot migrate at the same time. Only used by the CLI and tests, never at request time.
 */
const LOCK_KEY = 727_001; // arbitrary constant, unique to this app

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function runMigrations(pool: Pool, dir = join(process.cwd(), "db", "migrations")): Promise<MigrationResult> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();

  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query("create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query<{ version: string }>("select version from schema_migrations")).rows.map((r) => r.version));

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const file of files) {
      if (done.has(file)) {
        result.alreadyApplied.push(file);
        continue;
      }
      const sql = readFileSync(join(dir, file), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (version) values ($1)", [file]);
        await client.query("commit");
        result.applied.push(file);
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    }
    return result;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
