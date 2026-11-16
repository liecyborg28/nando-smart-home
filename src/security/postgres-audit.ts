import type { Pool } from "pg";
import type { Logger } from "@/lib/logger";
import type { AuditEntry, AuditLog } from "./audit";

const clip = (s: string | undefined, n: number): string | null => (s ? s.slice(0, n) : null);

/**
 * Durable audit trail in Postgres. Only entries worth keeping are stored (every write,
 * and every denial or failure); routine successful reads stay in the log stream.
 * Persisting is best effort and never blocks or fails the request: a database hiccup is
 * logged, and the same entry still went to the log stream.
 */
export function createPostgresAuditLog(pool: Pool, logger: Logger): AuditLog {
  // Inserts still in flight. Tracked so a serverless host can be told to wait for them (see AuditLog.settled).
  const pending = new Set<Promise<void>>();
  return {
    settled: async () => {
      await Promise.allSettled([...pending]);
    },
    record(entry: AuditEntry) {
      if (!(entry.write || entry.outcome !== "success")) return;
      const insert = pool
        .query(
          `insert into audit_log (token_id, actor_name, action, outcome, write, device_ids, error_code, note, request_id, client_ip, user_agent)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            clip(entry.actor, 64),
            clip(entry.actorName, 64),
            entry.action.slice(0, 200),
            entry.outcome,
            entry.write,
            entry.deviceIds?.slice(0, 20).map((d) => d.slice(0, 64)) ?? null,
            clip(entry.errorCode, 64),
            clip(entry.note, 500),
            clip(entry.requestId, 64),
            clip(entry.clientIp, 64),
            clip(entry.userAgent, 200),
          ],
        )
        .then(() => undefined)
        .catch((error: unknown) => logger.error("audit persistence failed", { error }));
      pending.add(insert);
      void insert.finally(() => pending.delete(insert));
    },
  };
}

/** Fan one audit entry out to several sinks; one failing sink never affects the others. */
export function combineAuditLogs(...sinks: AuditLog[]): AuditLog {
  return {
    settled: async () => {
      await Promise.allSettled(sinks.map((s) => s.settled?.()));
    },
    record(entry) {
      for (const sink of sinks) {
        try {
          sink.record(entry);
        } catch {
          // Auditing must never break the request it describes.
        }
      }
    },
  };
}
