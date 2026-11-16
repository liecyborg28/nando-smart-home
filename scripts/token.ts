import { userInfo } from "node:os";
import { createPool } from "@/db/pool";
import { PostgresTokenStore } from "@/security/postgres-token-store";
import { TOKEN_NAME_PATTERN, generateToken, scopesFor, type TokenSummary } from "@/security/token-store";

/**
 * Token administration. Run from any machine that has DATABASE_URL (no SSH to the server needed).
 *
 *   npm run token -- create <name> --scope read|write [--expires 30d]
 *   npm run token -- list
 *   npm run token -- revoke <id> [--reason "why"]
 *   npm run token -- revoke-all --yes [--reason "why"]
 *
 * A token is shown ONCE, at creation. Only its hash is stored. Tokens do not expire unless
 * --expires is given. A revoked token stops working within TOKEN_CACHE_TTL_SECONDS (default 5s).
 */
try {
  process.loadEnvFile(".env");
} catch {
  // Variables may come from the real environment instead of a file.
}

const USAGE = `Usage:
  npm run token -- create <name> --scope read|write [--expires 30d|12h|45m]
  npm run token -- list
  npm run token -- revoke <id> [--reason "why"]
  npm run token -- revoke-all --yes [--reason "why"]`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
const has = (name: string) => rest.includes(`--${name}`);
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1]!.startsWith("--") && rest[i - 1] !== "--yes"));

function parseDuration(value: string): number {
  const m = /^(\d{1,4})([mhd])$/.exec(value);
  if (!m) fail(`Invalid --expires "${value}". Use for example 30d, 12h or 45m.`);
  const n = Number(m[1]);
  return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
}

const fmt = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 19) : "-");

function printTable(tokens: TokenSummary[]): void {
  if (tokens.length === 0) {
    console.log("No tokens yet.");
    return;
  }
  const rows = tokens.map((t) => ({
    id: t.id,
    name: t.name,
    scopes: t.scopes.join("+"),
    status: t.revokedAt ? "REVOKED" : t.expiresAt && t.expiresAt <= new Date() ? "EXPIRED" : "active",
    created: fmt(t.createdAt),
    "last used": fmt(t.lastUsedAt),
    expires: t.expiresAt ? fmt(t.expiresAt) : "never",
  }));
  console.table(rows);
}

if (!command || !["create", "list", "revoke", "revoke-all"].includes(command)) fail(USAGE);

const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_POOLED;
if (!url) fail("DATABASE_URL is not set.");

const pool = createPool(url, { max: 1 });
const store = new PostgresTokenStore(pool);

try {
  if (command === "create") {
    const name = positional[0];
    const scope = flag("scope");
    if (!name || !TOKEN_NAME_PATTERN.test(name)) fail(`Give a name of 1-64 letters, digits, space, dot, dash or underscore.\n${USAGE}`);
    if (scope !== "read" && scope !== "write") fail(`--scope must be "read" or "write".\n${USAGE}`);
    const expires = flag("expires");
    const gen = generateToken();
    const summary = await store.create({
      id: gen.id,
      name,
      scopes: scopesFor(scope),
      secretHash: gen.secretHash,
      createdBy: `cli:${userInfo().username}`,
      expiresAt: expires ? new Date(Date.now() + parseDuration(expires)) : null,
    });
    console.log(`Created token "${summary.name}" (id ${summary.id}, scope ${scope}, ${summary.expiresAt ? `expires ${fmt(summary.expiresAt)}` : "no expiry"}).`);
    console.log("\nCopy it NOW. It cannot be shown again:\n");
    console.log(`  ${gen.token}\n`);
    console.log("Use it as:  Authorization: Bearer <token>");
  } else if (command === "list") {
    printTable(await store.list());
  } else if (command === "revoke") {
    const id = positional[0];
    if (!id || !/^[a-f0-9]{16}$/.test(id)) fail(`Give the 16-character token id (see "list").\n${USAGE}`);
    const done = await store.revoke(id, flag("reason"));
    console.log(done ? `Revoked ${id}. It stops working within the cache window (default 5s).` : `Nothing revoked: ${id} does not exist or was already revoked.`);
    if (!done) process.exitCode = 1;
  } else if (command === "revoke-all") {
    if (!has("yes")) fail(`This cuts off EVERY client. Re-run with --yes to confirm.\n${USAGE}`);
    console.log(`Revoked ${await store.revokeAll(flag("reason"))} token(s).`);
  }
} catch (error) {
  console.error("Failed:", String((error as Error).message).replace(/postgres(ql)?:\/\/\S+/g, "<url>"));
  process.exitCode = 1;
} finally {
  await pool.end();
}
