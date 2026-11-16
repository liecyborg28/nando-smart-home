import { toSafeError } from "@/core/errors";
import { getHttpContext } from "@/http/context";
import { getServices } from "@/services/container";
import { createRestApi, type RestApi } from "./api";

/** Composition root for the /api routes. Shares limiters, budget, audit and authentication with MCP. */
const KEY = Symbol.for("nando-smart-home.rest-api");
type Holder = { [KEY]?: RestApi };

export function getRestApi(): RestApi {
  const holder = globalThis as unknown as Holder;
  holder[KEY] ??= (() => {
    const ctx = getHttpContext();
    return createRestApi({ pipeline: ctx, services: getServices, audit: ctx.audit, budget: ctx.budget });
  })();
  return holder[KEY];
}

/** Runs a route against the shared API; a broken configuration becomes a safe 500, never a stack trace. */
export async function rest(call: (api: RestApi) => Promise<Response>): Promise<Response> {
  try {
    return await call(getRestApi());
  } catch (error) {
    return Response.json({ error: toSafeError(error) }, { status: 500 });
  }
}
