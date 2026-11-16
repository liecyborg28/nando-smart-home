import { createPool } from "@/db/pool";
import { runMigrations } from "@/db/migrate";

/**
 * Applies pending SQL migrations. Uses DATABASE_URL (the DIRECT connection): advisory
 * locks are not reliable through a transaction-mode pooler.
 *   npm run db:migrate
 */
try {
  process.loadEnvFile(".env");
} catch {
  // Variables may come from the real environment instead of a file.
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (use the direct, non-pooled connection string).");
  process.exit(1);
}

const pool = createPool(url, { max: 1 });
try {
  const result = await runMigrations(pool);
  console.log(result.applied.length ? `Applied: ${result.applied.join(", ")}` : "Nothing to apply.");
  if (result.alreadyApplied.length) console.log(`Already applied: ${result.alreadyApplied.join(", ")}`);
} catch (error) {
  console.error("Migration failed:", String((error as Error).message).replace(/postgres(ql)?:\/\/\S+/g, "<url>"));
  process.exitCode = 1;
} finally {
  await pool.end();
}
