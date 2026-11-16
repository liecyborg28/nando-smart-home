import { rest } from "@/rest/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Tuya calls take a few seconds at most; fail rather than hang a serverless invocation.
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export const GET = async (request: Request, { params }: Ctx) => rest(async (api) => api.getDeviceCapabilities(request, (await params).id));
export const OPTIONS = (request: Request) => rest((api) => api.preflight(request));
