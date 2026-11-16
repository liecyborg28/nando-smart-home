import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { AppError } from "@/core/errors";
import type { FixedWindowRateLimiter } from "@/security/rate-limit";
import type { AuditLog } from "@/security/audit";
import type { Scope } from "@/security/authentication";
import { chargeBudget as chargeSharedBudget } from "@/security/budget";
import { actorNameOf, actorOf, requestMetaOf, requireScope } from "@/security/authorization";
import type { Services } from "@/services/container";
import { failure, ok } from "./format";

export interface McpDeps {
  /** Lazy so the MCP surface (tools/list, prompts) works even when the provider is not configured. */
  services: () => Services;
  audit: AuditLog;
  /** false hides and refuses every control tool (CONTROL_ENABLED kill switch). Default true. */
  controlEnabled?: boolean;
  /** Per-token usage budget; each tool and resource charges its own cost. */
  budget?: FixedWindowRateLimiter;
}

/** Charges `cost` units to the caller; throws PROVIDER_RATE_LIMITED when the budget is spent. */
export function chargeBudget(deps: McpDeps, actor: string, cost: number): void {
  chargeSharedBudget(deps.budget, actor, cost);
}

export interface ToolSpec<A> {
  name: string;
  scope: Scope;
  write?: boolean;
  deviceIds?: (args: A) => string[];
  /** Relative provider cost of one call (default 1). Charged against the token's budget. */
  cost?: (args: A) => number;
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Wraps a tool body with the cross-cutting rules every tool must follow:
 * scope check, audit entry, and normalized error output. Tool bodies only call
 * application services, so REST and MCP share one implementation.
 */
export function guarded<A, D extends Record<string, unknown>>(
  deps: McpDeps,
  spec: ToolSpec<A>,
  run: (args: A, services: Services, call: { actor: string }) => Promise<{ data: D; summary: string; auditNote?: string }>,
): (args: A, ctx: ServerContext) => Promise<CallToolResult> {
  return async (args, ctx) => {
    const authInfo = ctx.http?.authInfo;
    const base = {
      actor: actorOf(authInfo),
      ...(actorNameOf(authInfo) ? { actorName: actorNameOf(authInfo) } : {}),
      ...requestMetaOf(authInfo),
      action: `tool:${spec.name}`,
      write: spec.write ?? false,
      ...(spec.deviceIds ? { deviceIds: spec.deviceIds(args) } : {}),
    };
    try {
      requireScope(authInfo, spec.scope);
      chargeBudget(deps, base.actor, spec.cost?.(args) ?? 1);
      const { data, summary, auditNote } = await run(args, deps.services(), { actor: base.actor });
      deps.audit.record({ ...base, outcome: "success", ...(auditNote ? { note: auditNote } : {}) });
      return ok(data, summary);
    } catch (error) {
      const denied = error instanceof AppError && error.code === "AUTHORIZATION_FAILED";
      deps.audit.record({
        ...base,
        outcome: denied ? "denied" : "failure",
        errorCode: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      });
      return failure(error);
    }
  };
}
