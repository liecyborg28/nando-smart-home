import type { Pool } from "pg";
import type { NewToken, TokenRecord, TokenScope, TokenStore, TokenSummary } from "./token-store";

interface Row {
  id: string;
  name: string;
  scopes: string[];
  secret_hash: Buffer;
  created_at: Date;
  created_by: string | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

const COLUMNS = "id, name, scopes, secret_hash, created_at, created_by, expires_at, last_used_at, revoked_at, revoked_reason";

function toRecord(r: Row): TokenRecord {
  return {
    id: r.id,
    name: r.name,
    scopes: r.scopes.filter((s): s is TokenScope => s === "read" || s === "write"),
    secretHash: r.secret_hash,
    createdAt: r.created_at,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
  };
}

function toSummary(r: Row): TokenSummary {
  const { secretHash: _omit, ...rest } = toRecord(r);
  void _omit;
  return rest;
}

/** Token store on Postgres. All statements are parameterized. */
export class PostgresTokenStore implements TokenStore {
  constructor(private readonly pool: Pool) {}

  async create(token: NewToken): Promise<TokenSummary> {
    const { rows } = await this.pool.query<Row>(
      `insert into api_tokens (id, name, scopes, secret_hash, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
      [token.id, token.name, token.scopes, token.secretHash, token.createdBy ?? null, token.expiresAt ?? null],
    );
    return toSummary(rows[0]!);
  }

  async findById(id: string): Promise<TokenRecord | undefined> {
    const { rows } = await this.pool.query<Row>(`select ${COLUMNS} from api_tokens where id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(): Promise<TokenSummary[]> {
    const { rows } = await this.pool.query<Row>(`select ${COLUMNS} from api_tokens order by created_at asc`);
    return rows.map(toSummary);
  }

  async revoke(id: string, reason?: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "update api_tokens set revoked_at = now(), revoked_reason = $2 where id = $1 and revoked_at is null",
      [id, reason ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async revokeAll(reason?: string): Promise<number> {
    const { rowCount } = await this.pool.query("update api_tokens set revoked_at = now(), revoked_reason = $1 where revoked_at is null", [reason ?? null]);
    return rowCount ?? 0;
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.pool.query("update api_tokens set last_used_at = $2 where id = $1", [id, at]);
  }
}
