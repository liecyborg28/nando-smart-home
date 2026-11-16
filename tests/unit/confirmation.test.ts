import { describe, expect, it } from "vitest";
import type { SmartHomeDevice } from "@/core/domain";
import { ConfirmationManager, InMemoryNonceStore, createConfirmationPolicy, fingerprint, type NonceStore } from "@/security/confirmation";

const binding = { actor: "tok-1", deviceId: "door", commands: [{ code: "lock_motor_state", value: false }] };
const SECRET = "secret-for-tests-0123456789-abcdefgh";

function manager(now = { t: 1_000_000 }, nonces?: NonceStore) {
  return { m: new ConfirmationManager(SECRET, () => now.t, 300, nonces ?? new InMemoryNonceStore(() => now.t)), now };
}

const reason = (r: string) => ({ code: "AUTHORIZATION_FAILED", context: { reason: r } });

describe("ConfirmationManager", () => {
  it("accepts a valid token exactly once", async () => {
    const { m } = manager();
    const { token, expiresInSeconds } = m.issue(binding);
    expect(expiresInSeconds).toBe(300);
    await expect(m.consume(token, binding)).resolves.toBeUndefined();
    await expect(m.consume(token, binding)).rejects.toMatchObject(reason("used"));
  });

  it("expires after the TTL", async () => {
    const { m, now } = manager();
    const { token } = m.issue(binding);
    now.t += 301_000;
    await expect(m.consume(token, binding)).rejects.toMatchObject(reason("expired"));
  });

  it("is bound to the exact commands, device and actor (token id)", async () => {
    const { m } = manager();
    const { token } = m.issue(binding);
    await expect(m.consume(token, { ...binding, commands: [{ code: "lock_motor_state", value: true }] })).rejects.toMatchObject(reason("mismatch"));
    await expect(m.consume(token, { ...binding, deviceId: "other" })).rejects.toMatchObject(reason("mismatch"));
    await expect(m.consume(token, { ...binding, actor: "tok-2" })).rejects.toMatchObject(reason("mismatch"));
    // None of the failed attempts consumed it.
    await expect(m.consume(token, binding)).resolves.toBeUndefined();
  });

  it("rejects tampered, truncated, foreign and garbage tokens", async () => {
    const { m } = manager();
    const other = new ConfirmationManager("a-different-secret-0123456789-abcdefgh", () => 1_000_000);
    const { token } = m.issue(binding);
    const [body, sig] = token.split(".") as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ a: "tok-1", d: "door", c: fingerprint(binding.commands), e: 9e15, n: "x" })).toString("base64url");
    for (const bad of [`${body}x.${sig}`, `${forgedBody}.${sig}`, `${body}.`, body, "", "a.b.c", other.issue(binding).token, "not a token"]) {
      await expect(m.consume(bad, binding)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    }
  });

  it("treats command order as irrelevant but values as significant", () => {
    const a = [{ code: "a", value: 1 }, { code: "b", value: 2 }];
    const b = [{ code: "b", value: 2 }, { code: "a", value: 1 }];
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).not.toBe(fingerprint([{ code: "a", value: 1 }, { code: "b", value: 3 }]));
  });

  it("does not embed the signing secret in the token", () => {
    const m = new ConfirmationManager("SUPER-SECRET-CONFIRMATION-VALUE-0123456789", () => 1);
    const { token } = m.issue(binding);
    expect(token).not.toContain("SUPER-SECRET");
    expect(Buffer.from(token.split(".")[0]!, "base64url").toString()).not.toContain("SUPER-SECRET");
  });

  it("single use holds ACROSS server instances that share a nonce store", async () => {
    const now = { t: 1_000_000 };
    const shared = new InMemoryNonceStore(() => now.t);
    const instanceA = new ConfirmationManager(SECRET, () => now.t, 300, shared);
    const instanceB = new ConfirmationManager(SECRET, () => now.t, 300, shared);
    const { token } = instanceA.issue(binding);
    await expect(instanceB.consume(token, binding)).resolves.toBeUndefined();
    await expect(instanceA.consume(token, binding)).rejects.toMatchObject(reason("used"));
  });

  it("fails CLOSED when single use cannot be recorded (nonce store down)", async () => {
    const broken: NonceStore = {
      markUsed: async () => {
        throw new Error("db down");
      },
    };
    const { m } = manager(undefined, broken);
    const { token } = m.issue(binding);
    await expect(m.consume(token, binding)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("is safe under concurrent replay: only one of many simultaneous uses wins", async () => {
    const { m } = manager();
    const { token } = m.issue(binding);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => m.consume(token, binding)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("InMemoryNonceStore", () => {
  it("reports first use once and forgets expired nonces", async () => {
    const now = { t: 0 };
    const s = new InMemoryNonceStore(() => now.t);
    expect(await s.markUsed("n", 1000)).toBe(true);
    expect(await s.markUsed("n", 1000)).toBe(false);
    now.t = 2000;
    expect(await s.markUsed("n", 3000)).toBe(true);
  });
});

describe("createConfirmationPolicy", () => {
  const device = (providerCode: string): SmartHomeDevice => ({ id: "d", provider: "tuya", name: "x", category: { kind: "other", providerCode }, online: true, isSubDevice: false });
  const policy = createConfirmationPolicy({ categories: ["ms", " CKMKZQ "], confirmAll: false });

  it("requires confirmation for configured categories (case-insensitive)", () => {
    expect(policy.evaluate(device("ms"), [{ code: "x", value: true }]).required).toBe(true);
    expect(policy.evaluate(device("ckmkzq"), [{ code: "x", value: true }]).required).toBe(true);
  });

  it("requires confirmation for lock/valve/garage/siren style command codes on any device", () => {
    for (const code of ["lock_motor_state", "child_lock", "valve_state", "garage_door", "siren_switch"]) {
      expect(policy.evaluate(device("dj"), [{ code, value: true }]).required).toBe(true);
    }
  });

  it("does not require confirmation for ordinary actions", () => {
    expect(policy.evaluate(device("dj"), [{ code: "switch_led", value: true }])).toEqual({ required: false });
  });

  it("can require confirmation for every action", () => {
    const all = createConfirmationPolicy({ categories: [], confirmAll: true });
    expect(all.evaluate(device("dj"), [{ code: "switch_led", value: true }]).required).toBe(true);
  });
});
