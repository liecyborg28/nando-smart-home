# Architecture

Nando Smart Home is a provider-independent smart-home service. Agents and apps talk to it over MCP or REST; it talks to a device provider (Tuya today). Nothing above the provider layer knows what Tuya is.

```
 AI agents (Agno, Claude, ...)        dashboards, apps, scripts
            |  MCP (Streamable HTTP)            |  REST
            v                                   v
      /mcp  route                         /api/*  routes
            \                                  /
             v                                v
        +---------------- request pipeline (src/http) ----------------+
        | per-IP limit > HTTPS > Host/Origin (+CORS) > token auth >   |
        | per-token limit + concurrency                               |
        +------------------------------+------------------------------+
                                       v
            MCP tools / resources / prompts (src/mcp)   REST handlers (src/rest)
                  scope check, usage budget, audit          scope check, budget, audit
                                       \                    /
                                        v                  v
                              application services (src/services)
                  devices | status | capabilities | control (+ verification)
                                        |
                                        v
                      SmartHomeProvider interface (src/providers)
                                CachingProvider
                                        |
                                        v
                       TuyaProvider  >  TuyaClient (signing, token manager)
                                        |
                                        v
                                   Tuya Cloud API
```

Postgres (Neon) holds tokens, one-time confirmation nonces and the audit log. It is not used for device data.

## Layers and what each may know

| Layer | Folder | Knows about | Must not know about |
|---|---|---|---|
| Domain | `src/core` | Devices, categories, capabilities, commands, errors, command validation | Any provider, HTTP, MCP |
| Provider | `src/providers` | One vendor's API, mapped to the domain | Who is calling, tokens, MCP/REST |
| Services | `src/services` | Use cases: list, status, capabilities, control + verification, confirmation policy | HTTP status codes, MCP formats |
| Security | `src/security` | Tokens, scopes, limiters, confirmation, audit | Providers, devices |
| HTTP pipeline | `src/http` | Request-level protections shared by every endpoint | What an endpoint does |
| MCP / REST | `src/mcp`, `src/rest` | Protocol shapes, schemas, error mapping | Provider details |
| Routes | `src/app` | Next.js entry points (thin) | Everything else |

Adding a second provider (for example Matter or Home Assistant) means implementing `SmartHomeProvider` and changing the composition root (`src/services/container.ts`). Services, MCP, REST, skills and clients stay as they are.

## One call, end to end

`turn_on_device` for an air conditioner:

1. **Pipeline**: the request must pass the per-IP limit, HTTPS, Host/Origin allowlist, then token authentication (Postgres lookup, hash compare, revocation, 5-second cache), then the per-token rate and concurrency limits.
2. **Tool guard**: the token needs the `write` scope; the usage budget is charged (cost 6); control must be enabled.
3. **Control service**: reads the device and its capabilities **fresh** (never cached); builds the command from the device's own power capability; validates it. Invalid means nothing is sent.
4. **Confirmation policy**: a high-impact device (or `CONFIRM_ALL_WRITES`) returns `confirmation_required` and stops. The second call carries the signed one-time token.
5. **Provider**: signs and sends the command to Tuya.
6. **Verification**: reads the device back and compares. The result is `confirmed`, `partially_verified`, `mismatch` or `not_verifiable` (infrared devices give no feedback).
7. **Audit**: the outcome is written to the log stream and, for controls and failures, to the `audit_log` table, tied to the request id returned in `X-Request-Id`.

## Design decisions

- **Capability-based control, no raw passthrough.** A command is only built from what the device reports it supports, and only after validation. There is no endpoint that forwards an arbitrary request to Tuya.
- **Allowlist mapping.** Provider responses are copied field by field into the domain; fields like `local_key`, IP address and user id are never copied, so they cannot leak by accident.
- **Untrusted device text.** A device name is attacker-influenced input (it can come from a shared home). Strings are sanitised and length-limited, and every response says they are data, not instructions.
- **Honest results.** `accepted` is distinct from `verified`. Nothing claims success without evidence.
- **One pipeline for every endpoint.** MCP and REST share the same protections and budgets, so a fix applies to both.
- **Stateless MCP.** No server-side sessions: any instance can answer any request, which suits serverless and horizontal scaling. The price is that limiters and caches live in memory per instance (see [security.md](security.md#8-batas-yang-diketahui)).
- **Tokens, not keys.** Revocable, individually named, hashed at rest, stored in Postgres. Fail closed when the database is unreachable.
- **Streamable HTTP only.** No STDIO or SSE adapter, by decision.

## Where things live

```
src/
  config/        environment schema (the only reader of process.env)
  core/          domain types, validation, errors
  providers/     interface, caching wrapper, tuya/
  services/      use cases and the composition root
  security/      auth, scopes, limiters, confirmation, audit
  http/          shared pipeline and context
  mcp/           server, tools, resources, prompts
  rest/          REST handlers
  db/            pool and migrations runner
  app/           Next.js routes: /mcp, /api/*
db/migrations/   SQL (no ORM)
scripts/         token CLI, migrations, secret scanner
skills/          Agent Skills
examples/        Agno and plain TypeScript clients
openapi.yaml     REST contract (checked by tests against the real routes)
```
