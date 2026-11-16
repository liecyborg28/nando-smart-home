import { rest } from "@/rest/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Tuya calls take a few seconds at most; fail rather than hang a serverless invocation.
export const maxDuration = 30;

export const GET = (request: Request) => rest((api) => api.providerStatus(request));
export const OPTIONS = (request: Request) => rest((api) => api.preflight(request));
