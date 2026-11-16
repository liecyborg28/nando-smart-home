import { AppError } from "@/core/errors";
import type { FixedWindowRateLimiter } from "./rate-limit";

/**
 * Charges `cost` units to the caller's usage budget and refuses when it is spent.
 * Cost reflects how many provider calls an operation can trigger, which protects the
 * provider's API quota from being burned by one client. Shared by MCP tools and REST routes.
 */
export function chargeBudget(budget: FixedWindowRateLimiter | undefined, actor: string, cost: number): void {
  if (!budget) return;
  const hit = budget.hit(actor, cost);
  if (!hit.allowed) {
    throw new AppError("PROVIDER_RATE_LIMITED", "Usage budget exceeded. Try again shortly.", {
      context: { retryAfterSeconds: hit.retryAfterSeconds },
    });
  }
}
