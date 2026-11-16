/**
 * Headers for every response of the API surface. The responses are JSON/SSE for
 * machines, never pages, so the policy is as strict as it can be.
 */
export function secureHeaders(options: { requestId?: string; hsts: boolean }): Record<string, string> {
  return {
    // Responses carry device state and results of actions: never cache them anywhere.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    ...(options.hsts ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
    ...(options.requestId ? { "X-Request-Id": options.requestId } : {}),
  };
}

/** Returns a copy of `response` with the security headers applied (response headers may be immutable). */
export function secureResponse(response: Response, options: { requestId?: string; hsts: boolean }): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(secureHeaders(options))) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
