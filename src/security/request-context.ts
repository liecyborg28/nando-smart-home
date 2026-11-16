import { randomUUID } from "node:crypto";

/**
 * Facts about an incoming request that are only trustworthy in the right setup.
 *
 * `X-Forwarded-*` headers are written by whoever the client talks to, so a client
 * connecting directly can forge them. They are therefore honoured only when
 * TRUSTED_PROXY_HOPS says how many of OUR proxies sit in front of the app, and
 * only the entries those proxies appended (counted from the right) are used.
 */

const IP_SHAPE = /^[0-9a-fA-F:.]{1,45}$/;

function fromRight(header: string | null, hops: number): string | undefined {
  if (!header || hops <= 0) return undefined;
  const parts = header.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - hops];
}

/** Client IP as seen by our outermost trusted proxy. Without trusted proxies there is no reliable IP. */
export function clientIp(request: Request, trustedHops: number): string {
  const ip = fromRight(request.headers.get("x-forwarded-for"), trustedHops);
  return ip && IP_SHAPE.test(ip) ? ip : trustedHops > 0 ? "unknown" : "direct";
}

export function requestProtocol(request: Request, trustedHops: number): "http" | "https" {
  const forwarded = fromRight(request.headers.get("x-forwarded-proto"), trustedHops)?.toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;
  return new URL(request.url).protocol === "https:" ? "https" : "http";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True only for a direct (non-proxied) request addressed to a loopback name. */
export function isDirectLocalRequest(request: Request, trustedHops: number): boolean {
  if (trustedHops > 0) return false;
  const host = (request.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(host);
}

export interface RequestMeta {
  requestId: string;
  clientIp: string;
  userAgent?: string;
}

export function requestMeta(request: Request, trustedHops: number): RequestMeta {
  // eslint-disable-next-line no-control-regex
  const ua = (request.headers.get("user-agent") ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  return { requestId: randomUUID(), clientIp: clientIp(request, trustedHops), ...(ua ? { userAgent: ua } : {}) };
}
