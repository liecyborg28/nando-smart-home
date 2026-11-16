-- Token store, one-time confirmation nonces, and a durable audit trail.
-- Plain SQL, no ORM. Every statement is idempotent-safe to read; the runner applies each file once.

create table api_tokens (
  -- Public identifier (16 hex chars). The secret half of a token is NEVER stored, only its SHA-256.
  id             text primary key check (id ~ '^[a-f0-9]{16}$'),
  name           text not null check (char_length(name) between 1 and 64),
  scopes         text[] not null check (cardinality(scopes) >= 1 and scopes <@ array['read', 'write']::text[]),
  secret_hash    bytea not null check (octet_length(secret_hash) = 32),
  created_at     timestamptz not null default now(),
  created_by     text,
  expires_at     timestamptz,
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_reason text
);

create index api_tokens_active_idx on api_tokens (id) where revoked_at is null;

-- Single-use enforcement for two-step confirmation tokens, safe across server instances.
create table confirmation_nonces (
  nonce      text primary key,
  expires_at timestamptz not null
);

create index confirmation_nonces_expiry_idx on confirmation_nonces (expires_at);

create table audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  token_id   text,
  actor_name text,
  action     text not null,
  outcome    text not null check (outcome in ('success', 'failure', 'denied')),
  write      boolean not null default false,
  device_ids text[],
  error_code text,
  note       text,
  request_id text,
  client_ip  text,
  user_agent text
);

create index audit_log_at_idx on audit_log (at desc);
create index audit_log_token_idx on audit_log (token_id, at desc);
