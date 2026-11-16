import { NextResponse } from "next/server";
import { appDatabaseUrl, getEnv, tuyaConfigFrom } from "@/config/env";
import { httpStatusFor, toSafeError } from "@/core/errors";
import { getHttpContext } from "@/http/context";
import { secureHeaders } from "@/security/http-headers";

// Node.js runtime: the app (and the MCP endpoint) relies on node:crypto.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Tuya calls take a few seconds at most; fail rather than hang a serverless invocation.
export const maxDuration = 30;

/**
 * Liveness. Anyone gets `{status:"ok"}`; configuration details (which providers and
 * stores are set up) are only shown with a valid token, so an anonymous caller learns
 * nothing about how the server is wired.
 */
export async function GET(request: Request) {
  const headers = secureHeaders({ hsts: false });
  try {
    const env = getEnv();
    const base = { status: "ok", service: "nando-smart-home", time: new Date().toISOString() };

    // Only try to authenticate when a credential was actually sent.
    if (request.headers.has("authorization")) {
      const auth = await getHttpContext().authenticator.authenticate(request);
      if (auth.ok) {
        return NextResponse.json(
          {
            ...base,
            providers: { tuya: { configured: tuyaConfigFrom(env) !== undefined } },
            database: { configured: appDatabaseUrl(env) !== undefined },
            control: { enabled: env.CONTROL_ENABLED === "true" },
          },
          { headers },
        );
      }
    }
    return NextResponse.json(base, { headers });
  } catch (error) {
    return NextResponse.json({ status: "error", error: toSafeError(error) }, { status: httpStatusFor(error), headers });
  }
}
