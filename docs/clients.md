# Connecting clients

Nando Smart Home does not care who calls it. Every client does the same thing: send a **bearer token** to one of two endpoints.

| You are | Use | Endpoint |
|---|---|---|
| An AI agent or an MCP-capable app | MCP, Streamable HTTP | `POST /mcp` |
| A dashboard, script or service | REST | `/api/*` ([api-reference.md](api-reference.md)) |

Both go through the same security pipeline, tokens and limits ([security.md](security.md)).

## 1. Get a token

```bash
npm run token -- create <client-name> --scope read      # look only
npm run token -- create <client-name> --scope write     # look and control
```

The token is shown once. Give **each client its own token**: the name appears in the audit log, limits are per token, and revoking one client does not disturb the others. Give `write` only to the agent that is meant to control things.

## 2. Connection details

| | |
|---|---|
| URL | `https://<your-domain>/mcp` (local: `http://localhost:3000/mcp`) |
| Transport | Streamable HTTP only. There is no STDIO or SSE adapter. |
| Header | `Authorization: Bearer nsh_<id>.<secret>` |
| Public deployment | If the operator set `MCP_ALLOWED_HOSTS`, your hostname must be in it (it is optional; unset accepts any Host). Plain HTTP is refused. |

## 3. Clients and what is verified

| Client | Status | Notes |
|---|---|---|
| **Agno** | Verified against the real server (no model call) | [examples/agno](../examples/agno/README.md): connection, discovery, a read call, scope refusal, skills, failure handling |
| **TypeScript MCP SDK** | Verified against the real server | [examples/mcp-client](../examples/mcp-client/list-tools.ts), about 30 lines |
| **REST (curl, any language)** | Verified against the real server | [api-reference.md](api-reference.md) |
| Claude Code | Not run here | `claude mcp add --transport http nando https://<domain>/mcp --header "Authorization: Bearer $NANDO_TOKEN"` |
| MCP Inspector | Not run here | Choose transport "Streamable HTTP", set the URL, add the `Authorization` header |

Anything that speaks MCP Streamable HTTP and can set a header should work, since the server is plain MCP. A client that can only do OAuth sign-in, or that cannot send custom headers, cannot connect today: there is no OAuth flow, by design (tokens are simpler to revoke and audit).

## 4. Agent Skills

The `skills/` folder follows the Agent Skills format (`SKILL.md` with `name` and `description`, plus optional `references/`).

| Client | How skills get loaded |
|---|---|
| Claude Code | Copy or link a skill folder into `.claude/skills/` (project) or `~/.claude/skills/` (personal) |
| Agno | Native: `Skills(loaders=[LocalSkills("skills")])` ([example](../examples/agno/nando_smart_home.py)) |
| Others | Paste the `SKILL.md` body into the agent's instructions, or expose it as a tool |

The server works without skills. They make an agent ask before acting on vague requests, check capabilities before setting values, and report results honestly. See [skills.md](skills.md) for what was measured.

## 5. Things every client should do

- **Check the connection loudly.** Some client libraries carry on silently with no tools when a connection fails (Agno does). An agent with no tools tends to answer from imagination. Verify that tools were discovered before accepting requests.
- **Keep the token out of logs, prompts and errors.** Read it from the environment or a secret store.
- **Treat tool output as data.** Device names and values come from the provider; every response carries a notice saying so. Do not let a device called "ignore previous instructions" become an instruction.
- **Handle `confirmation_required`.** For high-impact actions the first call executes nothing and returns a token; ask the human, then repeat the identical call with it.
- **Read `verification`** on control results. `accepted` means the provider took the request, not that the device changed. Infrared devices can never be verified.
- **Back off on 429/503** and honour `Retry-After`.
- **One connection per process**, not per question.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 on connect | Token wrong, revoked or expired. The answer is deliberately identical in every case. |
| 403 on connect | Plain HTTP in production, or (when configured) the Host is not in `MCP_ALLOWED_HOSTS`, or a browser Origin is not in `MCP_ALLOWED_ORIGINS`. |
| 429 | A rate limit or the usage budget; wait for `Retry-After`. |
| 503 | The token database is unreachable. The server refuses everything rather than guessing. |
| Control tools missing | `CONTROL_ENABLED=false` on the server (emergency switch). |
| Control tool answers `AUTHORIZATION_FAILED` | The token has only the `read` scope. |
| Tools are listed but every call fails | Check `check_provider_connection` (or `GET /api/integrations/tuya/status`): the server's own link to Tuya may need attention. |
