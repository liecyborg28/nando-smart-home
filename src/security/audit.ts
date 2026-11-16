import type { Logger } from "@/lib/logger";

/**
 * Audit trail for tool/resource use. Writes and every denial/failure are logged
 * at info level so they are retained; routine successful reads are debug-only.
 * Entries identify the actor and targets but never payload secrets (the logger
 * also redacts sensitive keys).
 */
export interface AuditEntry {
  /** Token id. */
  actor: string;
  /** Operator-chosen token label. */
  actorName?: string;
  /** e.g. "tool:turn_on_device", "resource:smarthome://devices" */
  action: string;
  write: boolean;
  outcome: "success" | "failure" | "denied";
  deviceIds?: string[];
  errorCode?: string;
  /** Short non-sensitive detail, e.g. "executed:confirmed" or "confirmation_required". */
  note?: string;
  requestId?: string;
  clientIp?: string;
  userAgent?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
  /**
   * Resolves once every entry handed to `record()` so far is durable. `record()` itself never blocks the
   * request; serverless hosts (Vercel) may freeze the process right after the response, so the HTTP layer
   * asks the platform to keep it alive until this settles. Never rejects.
   */
  settled?(): Promise<void>;
}

export function createAuditLog(logger: Logger): AuditLog {
  const audit = logger.child({ channel: "audit" });
  return {
    record(entry) {
      const important = entry.write || entry.outcome !== "success";
      (important ? audit.info : audit.debug)("audit", { ...entry });
    },
  };
}

export const noopAudit: AuditLog = { record() {} };
