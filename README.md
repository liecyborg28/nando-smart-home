# Nando Smart Home

A provider-independent smart-home service for AI agents and apps. Agents look at and control your devices through **MCP** (Streamable HTTP) or **REST**; the service talks to the device provider (**Tuya / Smart Life** first) and hides it from everything above.

- **Safe by construction.** Revocable per-client tokens, read/write scopes, rate limits and a usage budget, two-step confirmation for high-impact actions, an audit log, and an emergency off switch. Control is capability-based: only what a device says it supports, only after validation.
- **Honest results.** "The provider accepted it" is reported separately from "the device actually changed". Infrared devices that give no feedback are reported as unverifiable, never as success.
- **Agent-ready.** 11 MCP tools, resources and prompts, plus Agent Skills that teach an agent to ask before acting, check capabilities first, and report truthfully.

## Quick start

```bash
npm install
cp .env.example .env            # fill in Tuya + Postgres + CONFIRMATION_SECRET
npm run db:migrate
npm run token -- create me --scope read      # shown once
npm run dev
```

```bash
curl http://localhost:3000/api/health
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/devices
```

Step by step, with Tuya setup and troubleshooting: [docs/setup.md](docs/setup.md).

## Connect a client

| | |
|---|---|
| MCP endpoint | `POST /mcp` (Streamable HTTP only) |
| REST | `/api/*` ([contract](openapi.yaml)) |
| Auth | `Authorization: Bearer nsh_<id>.<secret>` |

Agno, plain TypeScript, REST and others: [docs/clients.md](docs/clients.md). Runnable examples in [examples/](examples/).

## Documentation

| | |
|---|---|
| [docs/setup.md](docs/setup.md) | Local setup from zero (Indonesian) |
| [docs/deployment.md](docs/deployment.md) | Vercel, Docker, monitoring, operations (Indonesian) |
| [docs/architecture.md](docs/architecture.md) | Layers, one call end to end, design decisions |
| [docs/mcp-tools.md](docs/mcp-tools.md) | Every tool, resource and prompt |
| [docs/api-reference.md](docs/api-reference.md) | REST endpoints, errors, CORS |
| [docs/clients.md](docs/clients.md) | Connecting Agno and other clients |
| [docs/skills.md](docs/skills.md) | The Agent Skills and how they were evaluated |
| [docs/security.md](docs/security.md) | Tokens, limits, confirmation, audit, incidents (Indonesian) |
| [docs/security-review.md](docs/security-review.md) | Final review: findings and remaining risks (Indonesian) |

## Commands

| | |
|---|---|
| `npm run dev` / `build` / `start` | Run, build the production bundle, start it |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Automated tests (no network) |
| `npm run test:live` | Read-only tests against real Tuya and Postgres |
| `npm run db:migrate` | Create or update the database tables |
| `npm run token -- <create\|list\|revoke\|revoke-all>` | Manage client tokens |
| `npm run check:secrets` | Scan for leaked secrets (also the pre-commit hook) |

On Windows, run the tests from a path with an **uppercase** drive letter (`D:\...`); a lowercase `d:\...` (for example from `cd /d/...` in Git Bash) breaks Vitest.

## Status

Built in nine phases (domain, Tuya provider, services, MCP, control with safety, skills, REST, client integration, production readiness). Verified against a real Tuya account and a real Postgres database, with the mock-based test suite as the safety net.

Not yet verified, so treat as unproven: a real Vercel deployment, the Docker image, and natural-language agent behaviour with a live model. See [docs/security-review.md](docs/security-review.md) for the full list of known risks. Not built: an admin web page for tokens (CLI for now), shared rate limits across instances, idempotency keys, and other providers.

## Layout

```
src/        core, providers, services, security, http pipeline, mcp, rest, app routes
skills/     Agent Skills (smart-home, device-management, home-automation)
examples/   Agno agent, plain TypeScript client
db/         SQL migrations
scripts/    token CLI, migrations, secret scanner
tests/      unit, integration, security, contract, deploy, live (opt-in)
```

## License

[MIT](LICENSE). Use it, change it, share it; there is no warranty. This software can control physical devices in your home, so read [docs/security.md](docs/security.md) and [docs/security-review.md](docs/security-review.md) before exposing it to the internet.
