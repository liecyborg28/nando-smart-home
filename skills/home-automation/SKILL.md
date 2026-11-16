---
name: home-automation
description: Plan and run multi-device or multi-step smart home requests with the Nando Smart Home MCP tools - checking every device, asking before sensitive or sweeping actions, executing step by step, and reporting partial failures and unverified results honestly. Use when the user wants several devices changed at once or a routine or scene - "matikan semua lampu", "mode tidur", "goodnight", "pergi dari rumah", "set AC ke 24 dan matikan lampu ruang tamu", "turn off everything", "nyalakan semua" - or any request touching more than one device, mixing devices of different kinds, or involving locks/doors together with other devices.
---

# Home automation (several devices, several steps)

A single device is handled by the `smart-home` skill; follow its rules for every step here (look first, capability check, confirmation flow, honest reporting). This skill adds what changes when there are many devices: planning, scope, ordering, and reporting what happened to each one.

Reply in the user's language. End with a short per-device result list.

## 1. Understand the scope exactly

Turn the request into a list of concrete targets before touching anything:

1. `list_devices` for the real inventory.
2. Decide which devices the words cover. "Semua lampu" is every device of kind `light`, not the AC, not sockets. Do not widen.
3. **When the scope is vague or very broad** ("matikan semua", "turn off everything", "pergi dari rumah"), do not act on a guess. List the devices that would be affected and the action for each, mention anything high impact or one-way (infrared) or that you would normally leave alone (a router or refrigerator on a smart plug, a door lock), and ask the user to confirm the plan. A clearly bounded request ("semua lampu") needs no extra question: just do it.
4. A routine ("mode tidur") has no fixed meaning. If the user has not defined it, propose a plan from the actual devices and capabilities and ask before running it.

## 2. Check each target

For each device: is it `online`, and does it have the capability you need (`get_device_capabilities`, writable, value in range)? Sort the targets into:

- **Ready**: online and capable.
- **Not possible**: offline, or lacks the capability, or read-only. Do not try them; they go in the report.
- **Needs the user**: ambiguous, out of range, or high impact.

Show a short plan when the plan is not obvious or has consequences: "Akan dilakukan: A mati, B mati. Tidak bisa: C (offline)."

## 3. Execute one step at a time

- Run one control call per device. Use `execute_device_command` only for several settings on the *same* device.
- Read each response before the next call. If a step returns `confirmation_required`, nothing happened for that device: handle it with the user (never self-confirm) and carry on with the others if they are independent.
- A failure on one device does not cancel the independent others; do not leave the user with a half-finished state silently. Dependent steps (do B only if A worked) stop at the failure.
- Do not retry failures in a loop. A single retry is fine only for retryable errors (`PROVIDER_UNAVAILABLE`, `REQUEST_TIMEOUT`, `PROVIDER_RATE_LIMITED` after waiting).
- Stay inside the limits: the usage budget and the control rate limit are real. For many devices, go steadily and say if you hit a limit.

## 4. Verify and report per device

Use each response's `verification.result` as in the `smart-home` skill. Do not re-read states yourself just to look busy; the control call already read back.

Finish with a list that gives each target its own honest line:

```
Lampu Ruang Tamu - mati (terkonfirmasi)
Lampu Kamar      - perintah terkirim, tapi status belum berubah (belum berhasil)
Lampu Dapur      - offline, tidak diubah
AC Kost          - perintah terkirim, tidak bisa diverifikasi (IR)
```

Then one sentence on what is left for the user (check the kitchen lamp's power; look at the AC). Never summarize partial results as "done" or "semua sudah mati".

## 5. Sensitive combinations

- Locks, garage doors and valves always follow the confirmation flow, individually, even inside a routine. Never fold them into a bulk "yes".
- Leaving-home style requests are where mistakes hurt (a lock left open, a heater left on). State clearly what is confirmed done, what is unconfirmed, and what you could not do.
- Do not do extra things the user did not ask for "to be helpful".
