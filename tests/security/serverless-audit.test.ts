import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createLogger } from "@/lib/logger";
import { combineAuditLogs, createPostgresAuditLog } from "@/security/postgres-audit";
import type { AuditEntry, AuditLog } from "@/security/audit";
import { createHarness, READ_KEY } from "../helpers/mcp-harness";

const logger = createLogger({ level: "error", sink: () => {} });

const controlEntry: AuditEntry = { actor: "t1", action: "tool:turn_on_device", write: true, outcome: "success" };

/** A pool whose inserts finish only when the test says so, like a slow database. */
function slowPool() {
  const finishers: Array<() => void> = [];
  const query = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        finishers.push(() => resolve({ rowCount: 1 }));
      }),
  );
  return { pool: { query } as unknown as Pool, query, finishAll: () => finishers.splice(0).forEach((f) => f()) };
}

describe("audit durability on serverless hosts", () => {
  it("settled() waits for inserts that are still in flight", async () => {
    const { pool, query, finishAll } = slowPool();
    const audit = createPostgresAuditLog(pool, logger);

    audit.record(controlEntry);
    expect(query).toHaveBeenCalledTimes(1);

    let done = false;
    const waiting = audit.settled!().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false); // the insert has not finished, so the host must keep the process alive

    finishAll();
    await waiting;
    expect(done).toBe(true);
  });

  it("settled() resolves immediately when nothing is pending, and ignores routine successful reads", async () => {
    const { pool, query } = slowPool();
    const audit = createPostgresAuditLog(pool, logger);
    audit.record({ ...controlEntry, write: false, outcome: "success" }); // a plain read: not persisted
    expect(query).not.toHaveBeenCalled();
    await expect(audit.settled!()).resolves.toBeUndefined();
  });

  it("settled() never rejects, even when the database fails", async () => {
    const failing = { query: vi.fn(() => Promise.reject(new Error("db down"))) } as unknown as Pool;
    const audit = createPostgresAuditLog(failing, logger);
    audit.record(controlEntry);
    await expect(audit.settled!()).resolves.toBeUndefined();
  });

  it("a finished insert is forgotten, so memory does not grow", async () => {
    const { pool, finishAll } = slowPool();
    const audit = createPostgresAuditLog(pool, logger);
    for (let i = 0; i < 50; i++) audit.record(controlEntry);
    finishAll();
    await audit.settled!();
    const sizeProbe = vi.fn();
    await audit.settled!().then(sizeProbe);
    expect(sizeProbe).toHaveBeenCalled(); // resolves instantly: nothing left to wait for
  });

  it("combineAuditLogs waits for every sink that can be waited for", async () => {
    const { pool, finishAll } = slowPool();
    const pg = createPostgresAuditLog(pool, logger);
    const plain: AuditLog = { record() {} }; // a sink without settled(), like the log-stream audit
    const both = combineAuditLogs(plain, pg);

    both.record(controlEntry);
    let done = false;
    const waiting = both.settled!().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    finishAll();
    await waiting;
    expect(done).toBe(true);
  });
});

describe("the pipeline asks the host to wait for background work", () => {
  it("calls afterResponse exactly once per request, whatever the outcome", async () => {
    const h = createHarness();
    const hook = vi.fn();
    h.deps.afterResponse = hook;
    try {
      await h.http("/mcp", { method: "POST" }); // no token: refused with 401
      expect(hook).toHaveBeenCalledTimes(1);
      const res = await h.http("/mcp", { method: "POST", headers: { Authorization: `Bearer ${READ_KEY}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
      expect(res.status).not.toBe(401);
      expect(hook).toHaveBeenCalledTimes(2);
    } finally {
      await h.close();
    }
  });

  it("still calls it when the request is refused before authentication (per-IP limit)", async () => {
    const h = createHarness({ ipRateLimit: 1 });
    const hook = vi.fn();
    h.deps.afterResponse = hook;
    try {
      await h.http("/mcp", { method: "POST" });
      const limited = await h.http("/mcp", { method: "POST" });
      expect(limited.status).toBe(429);
      expect(hook).toHaveBeenCalledTimes(2);
    } finally {
      await h.close();
    }
  });
});
