# REST API reference

The REST API serves applications that do not speak MCP (dashboards, the ORB app wrapper, other services). It is a thin layer over **the same application services** as the MCP tools, behind **the same security pipeline**, so a rule enforced for one is enforced for the other.

The machine-readable contract is [`openapi.yaml`](../openapi.yaml) (OpenAPI 3.1). A test checks it against the real routes and the real responses, so it cannot drift silently.

## Basics

| | |
|---|---|
| Base path | `/api` |
| Authentication | `Authorization: Bearer nsh_<id>.<secret>` on everything except `GET /api/health` |
| Tokens | `npm run token -- create <name> --scope read` or `--scope write` (see [security.md](security.md)) |
| Format | JSON in, JSON out. Bodies must be `application/json`, at most 64 KiB |
| Success | `{ "data": ..., "notice": "..." }` |
| Error | `{ "error": { "code", "message", "retryable", "context"? } }` |
| Trace | every response has `X-Request-Id`; it matches the audit log |

`notice` reminds you that device names and values are **untrusted text** from the provider. Keep it if you pass responses to a language model.

## Endpoints

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/api/health` | none | Liveness. With a token it also shows what is configured. |
| GET | `/api/devices` | read | List devices. Filters: `category`, `room`, `online`. |
| GET | `/api/devices/{id}` | read | One device. |
| GET | `/api/devices/{id}/status` | read | Current state. |
| GET | `/api/devices/{id}/capabilities` | read | What the device supports (types, ranges, read/write). |
| POST | `/api/devices/{id}/commands` | **write** | Send commands. |
| GET | `/api/integrations/tuya/status` | read | Can the server reach Tuya and is it authorised? |

Not implemented: `integrations/tuya/link` from the original brief. Linking a Smart Life account happens in the Tuya IoT console (see the setup notes), not through this API.

## Examples

```bash
TOKEN=nsh_...        # from: npm run token -- create ...
BASE=https://home.example.com

curl -H "Authorization: Bearer $TOKEN" "$BASE/api/devices?category=light&online=true"
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/devices/<id>/capabilities"

curl -X POST "$BASE/api/devices/<id>/commands" \
  -H "Authorization: Bearer $WRITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"commands":[{"code":"switch_led","value":true}]}'
```

## Sending commands

1. Read `GET /api/devices/{id}/capabilities`. Only `write` / `read-write` capabilities can be set, and the value must fit the type and `constraints`.
2. `POST` one to ten commands with distinct codes. They are validated together: if any is invalid, **nothing** is sent.
3. Read the result honestly:

| `verification.result` | Meaning |
|---|---|
| `confirmed` | The device was read back and matches. |
| `partially_verified` | Some properties matched, others cannot be compared. |
| `mismatch` | The provider accepted the command but the device did **not** change. |
| `not_verifiable` | No feedback is possible (infrared devices). The command was sent; whether it worked is unknown. |

`accepted: true` only means the provider took the request.

### High-impact actions: HTTP 428

Door locks, garage doors, valves and similar are not executed on the first request. The API answers **`428 Precondition Required`** with a one-time token and executes nothing:

```json
{ "data": { "status": "confirmation_required", "confirmation": { "token": "…", "expiresInSeconds": 300, "reason": "…", "instruction": "…" } } }
```

Ask the person. Only after an explicit yes, repeat the **identical** request with `"confirmationToken": "…"`. The token is bound to your token, the device and the exact commands, works once, and expires after 5 minutes. A status code of 428 (not 200) means a client that only checks the code cannot mistake it for success.

## Errors

| HTTP | `error.code` | Typical cause |
|---|---|---|
| 400 | `INVALID_REQUEST` | Bad query parameter, body field, JSON, or an unknown field (they are rejected, not ignored). |
| 400 | `INVALID_DEVICE_COMMAND` | Value out of range or wrong type for a real capability. |
| 401 | `AUTHENTICATION_FAILED` | Missing, unknown, revoked or expired token. The answer is identical in every case. |
| 403 | `AUTHORIZATION_FAILED` | Read token on a write route, control disabled, rejected confirmation token, wrong host/origin, or plain HTTP in production. |
| 404 | `DEVICE_NOT_FOUND` | Unknown device, or a malformed id. |
| 409 | `DEVICE_OFFLINE` | The device cannot be controlled right now. |
| 413 / 415 | `INVALID_REQUEST` | Body too large / not JSON. |
| 422 | `UNSUPPORTED_OPERATION` | Capability missing, read-only, or the device has no specification (hubs). |
| 429 | `PROVIDER_RATE_LIMITED` | A rate limit or usage budget; wait for `Retry-After`. |
| 502 / 503 / 504 | `PROVIDER_UNAVAILABLE`, `REQUEST_TIMEOUT` | Provider or token store down; retry later. |

If the server's own credentials to Tuya fail, you get **502** `PROVIDER_UNAVAILABLE`, never 401: a 401 would tell you that *your* token is wrong when it is not.

## Browsers and CORS

For dashboards running in a browser, add the dashboard's hostname to `MCP_ALLOWED_ORIGINS` (the same allowlist protects `/mcp`). Allowed origins get `Access-Control-Allow-Origin` with that exact origin (never `*`), preflights are answered without credentials, and no cookies are ever used: the token travels in the `Authorization` header. Any other origin gets 403. Keep the token out of browser code you do not control; a dashboard needs its own read-only token.

## Limits

The same limits and usage budget as MCP apply per token (see [security.md](security.md#4-batas-yang-berlaku)). Each call is charged by its provider cost: list/device = 1, status = 2, capabilities = 2, command = 6, provider status = 1.

## What is intentionally missing

- **No arbitrary provider requests.** Only the capability-based operations above exist.
- **No bulk or batch endpoints yet.** Use MCP's `get_multiple_device_status` if you need one call for many devices, or issue several GETs (they are cached for a few seconds).
- **No idempotency keys.** A command that is sent twice is applied twice; most capabilities (power, set value) are naturally repeatable, but check `verification` before retrying.
