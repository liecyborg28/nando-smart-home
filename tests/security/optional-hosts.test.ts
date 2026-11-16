import { describe, expect, it } from "vitest";
import { allowedHosts, parseEnv } from "@/config/env";
import { createHarness, READ_KEY } from "../helpers/mcp-harness";
import { createRestHarness } from "../helpers/rest-harness";

const mcpCall = (h: ReturnType<typeof createHarness>, headers: Record<string, string>) =>
  h.http("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: "{}",
  });

describe("MCP_ALLOWED_HOSTS is optional", () => {
  describe("parsing", () => {
    it.each([
      ["unset", {}, []],
      ["empty", { MCP_ALLOWED_HOSTS: "" }, []],
      ["only blanks", { MCP_ALLOWED_HOSTS: "   " }, []],
      ["only separators", { MCP_ALLOWED_HOSTS: " , ,," }, []],
      ["one host", { MCP_ALLOWED_HOSTS: "home.example.com" }, ["home.example.com"]],
      ["several, with stray spaces", { MCP_ALLOWED_HOSTS: " a.example.com , b.example.com,," }, ["a.example.com", "b.example.com"]],
    ])("%s", (_label, input, expected) => {
      expect(allowedHosts(parseEnv(input))).toEqual(expected);
    });
  });

  describe("when it is NOT set, any Host may connect", () => {
    it.each(["evil.example.com", "home.example.com", "10.0.0.5:3000", "192.168.1.20", "namaproject.vercel.app", "[::1]:3000"])(
      "REST accepts Host %s (with a valid token)",
      async (host) => {
        const res = await createRestHarness().get("/api/devices", { headers: { host } });
        expect(res.status).toBe(200);
      },
    );

    it("MCP accepts an arbitrary Host (with a valid token)", async () => {
      const h = createHarness();
      try {
        for (const host of ["evil.example.com", "10.0.0.5:3000", "namaproject.vercel.app"]) {
          const res = await mcpCall(h, { authorization: `Bearer ${READ_KEY}`, host });
          expect([401, 403]).not.toContain(res.status);
        }
      } finally {
        await h.close();
      }
    });

    it("the token is still required: any Host without a valid token gets 401", async () => {
      const h = createRestHarness();
      for (const token of [null, "junk"]) {
        expect((await h.get("/api/devices", { token, headers: { host: "evil.example.com" } })).status).toBe(401);
      }
      const mcp = createHarness();
      try {
        expect((await mcpCall(mcp, { host: "evil.example.com" })).status).toBe(401);
      } finally {
        await mcp.close();
      }
    });

    it("browser Origins stay an explicit allowlist: an unknown Origin is still refused", async () => {
      const res = await createRestHarness().get("/api/devices", { headers: { host: "evil.example.com", origin: "https://evil.example.com" } });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("HTTPS is still required in production regardless of Host", async () => {
      const res = await createRestHarness({ env: { NODE_ENV: "production", TRUSTED_PROXY_HOPS: "1" } }).get("/api/devices", {
        headers: { host: "anything.example.com", "x-forwarded-proto": "http" },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("when it IS set, the allowlist is strict", () => {
    it("refuses other Hosts and accepts the configured ones", async () => {
      const h = createRestHarness({ env: { MCP_ALLOWED_HOSTS: "a.example.com,b.example.com" } });
      expect((await h.get("/api/devices", { headers: { host: "evil.example.com" } })).status).toBe(403);
      expect((await h.get("/api/devices", { headers: { host: "10.0.0.5:3000" } })).status).toBe(403);
      expect((await h.get("/api/devices", { headers: { host: "a.example.com" } })).status).toBe(200);
      expect((await h.get("/api/devices", { headers: { host: "b.example.com" } })).status).toBe(200);
    });
  });
});
