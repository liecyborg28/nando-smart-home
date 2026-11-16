import { describe, expect, it, vi } from "vitest";
import type { TuyaConfig } from "@/config/env";
import { MAX_RESPONSE_BYTES, TuyaClient } from "@/providers/tuya/tuya.client";

const config: TuyaConfig = { accessId: "id", accessSecret: "secret", baseUrl: "https://openapi-sg.iotbing.com", timeoutMs: 5000 };
const TOKEN = { success: true, result: { access_token: "AT", refresh_token: "RT", expire_time: 7200 } };

function client(respond: (url: URL, init: RequestInit) => Response) {
  const inits: RequestInit[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    inits.push(init ?? {});
    return respond(new URL(String(input)), init ?? {});
  });
  return { c: new TuyaClient(config, { fetch: fetchMock as unknown as typeof fetch, now: () => 1_700_000_000_000 }), inits };
}

describe("Tuya client: redirects", () => {
  it("never follows a redirect (it would carry our signed headers to another host)", async () => {
    const { c, inits } = client(() => Response.json(TOKEN));
    await c.verifyConnection();
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) expect(init.redirect).toBe("error");
  });

  it("treats a redirect failure as the provider being unavailable, without leaking the target", async () => {
    const { c } = client(() => {
      throw new TypeError("fetch failed: redirect to https://attacker.example/steal");
    });
    const err = await c.verifyConnection().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(JSON.stringify((err as { toSafe(): unknown }).toSafe())).not.toContain("attacker");
  });
});

describe("Tuya client: response size", () => {
  it("rejects a response that declares an oversized Content-Length", async () => {
    const { c } = client(() => new Response("{}", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
    await expect(c.verifyConnection()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: expect.stringContaining("oversized") });
  });

  it("stops reading a body that grows past the cap even when it declares nothing", async () => {
    let chunksRead = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead++;
        controller.enqueue(new Uint8Array(64 * 1024).fill(120));
        if (chunksRead > 200) controller.close(); // would be 12.8 MB if read to the end
      },
    });
    const { c } = client(() => new Response(body));
    await expect(c.verifyConnection()).rejects.toMatchObject({ message: expect.stringContaining("oversized") });
    expect(chunksRead).toBeLessThan(40); // gave up near 1 MiB, did not buffer everything
  });

  it("still accepts normal responses, including large-but-legitimate ones", async () => {
    const devices = Array.from({ length: 300 }, (_, i) => ({ id: `d${i}`, name: "x".repeat(100) }));
    const { c } = client((url) => (url.pathname === "/v1.0/token" ? Response.json(TOKEN) : Response.json({ success: true, result: { devices, has_more: false } })));
    const out = await c.request<{ devices: unknown[] }>({ method: "GET", path: "/v1.0/iot-01/associated-users/devices" });
    expect(out.devices).toHaveLength(300);
  });

  it("maps an unparsable body to a provider error, not a crash", async () => {
    const { c } = client(() => new Response("<html>gateway error</html>", { status: 502 }));
    await expect(c.verifyConnection()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
