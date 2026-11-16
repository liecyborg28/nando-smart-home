# Controlling devices: arguments, rules, errors

## Contents
1. Tool arguments
2. Choosing values
3. The confirmation flow
4. Reading a control response
5. Error codes and what to do
6. Staying within limits

## 1. Tool arguments

| Tool | Arguments |
|---|---|
| `turn_on_device` / `turn_off_device` | `deviceId`, optional `confirmationToken` |
| `set_device_property` | `deviceId`, `code`, `value` (string, number or boolean), optional `confirmationToken` |
| `execute_device_command` | `deviceId`, `commands`: 1 to 10 items `{code, value}` with distinct codes, optional `confirmationToken` |

`deviceId` must be copied exactly from `list_devices`. A command list is all-or-nothing: if any item is invalid, nothing is sent.

## 2. Choosing values

Use only capabilities from `get_device_capabilities` with `access` `write` or `read-write`.

| `kind` | Valid value |
|---|---|
| `boolean` | `true` or `false` |
| `integer` | whole number within `min`..`max`, on the `step` grid starting at `min` |
| `enum` | one of `constraints.range` (text); some devices describe an enum as a numeric `min`..`max` instead, then send a whole number in that range |
| `string` | text up to 255 characters; if `constraints.raw` is set, exactly that value |
| `json`, `raw`, `bitmap`, `unknown` | not controllable through these tools: tell the user |

If the user asks for something outside the range (for example 40 degrees on an air conditioner limited to 16-30), do not send it. Tell them the allowed range and offer the nearest valid value, and let them choose.

## 3. The confirmation flow

Some actions are high impact (door locks, garage doors, water valves, sirens, and anything the operator configured). The server then answers the first call with:

```
status: "confirmation_required"
confirmation: { token, expiresInSeconds, reason, instruction }
```

Nothing has been sent. What you do:

1. Tell the user, in plain words: which device, what change, and the `reason`.
2. Ask for an explicit yes. A vague reply, or silence, is not consent.
3. On a clear yes, repeat exactly the same tool call with `confirmationToken` set to the token. Same device, same code, same value.
4. If anything differs, or the token is refused (`AUTHORIZATION_FAILED`: expired, already used, or different action), start over from step 1 with a fresh request.

Never call again on your own after receiving a token, even if the user's original message sounded like consent. The original request was for the action; the confirmation is a separate, informed decision made after seeing what is about to happen.

## 4. Reading a control response

```
status: "executed" | "confirmation_required"
accepted: true            // the provider took the request; NOT proof the device acted
verification: { result, details: [{code, expected, actual, outcome}], note }
```

`details` shows, per property, what you asked for (`expected`) and what the device reports (`actual`). Use it when you need to be specific. See the table in `SKILL.md` for what to say per `result`.

## 5. Error codes and what to do

Errors arrive as `Error <CODE>: <message>`.

| Code | Meaning | Do |
|---|---|---|
| `DEVICE_NOT_FOUND` | Not linked to this account, or the id is wrong | Re-run `list_devices`; do not guess. |
| `DEVICE_OFFLINE` | Cannot be controlled now | Report it; suggest checking power/Wi-Fi. Do not loop. |
| `UNSUPPORTED_OPERATION` | The device lacks this capability, it is read-only, or it has no controls (hubs) | Explain; offer what it does support. |
| `INVALID_DEVICE_COMMAND` | Value out of range / wrong type / several power switches | Read the message (it states the allowed values); ask the user. |
| `AUTHORIZATION_FAILED` | Token cannot do this, control is disabled, or a confirmation token was rejected | Say what is not permitted. Do not try another route. |
| `AUTHENTICATION_FAILED` | The connection credentials are wrong or revoked | Tell the user the connection needs attention. |
| `PROVIDER_RATE_LIMITED` | Too many calls or the usage budget is spent | Wait (the error is retryable) and use fewer calls: prefer `get_multiple_device_status` and `get_smart_home_overview` over many single calls. |
| `PROVIDER_UNAVAILABLE`, `REQUEST_TIMEOUT` | The cloud is down or slow | Retryable once or twice after a short pause; then report it. |
| `TOKEN_EXPIRED` | The provider session expired | Usually recovers on its own; one retry is fine. |
| `INTERNAL_ERROR` | Unexpected server error | Report it; do not retry repeatedly. |

## 6. Staying within limits

- Batch status reads: up to 20 ids per `get_multiple_device_status`.
- One control call already reads the device, sends, and re-reads state. Do not add your own status calls around it.
- Control calls are rate limited per minute. For many devices, spread the work and report progress rather than hammering.
