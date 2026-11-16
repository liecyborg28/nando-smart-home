import { describe, expect, it } from "vitest";
import { appDatabaseUrl, httpsRequired, parseEnv, tuyaConfigFrom } from "@/config/env";

describe("parseEnv", () => {
  it("boots with defaults and no Tuya credentials", () => {
    const env = parseEnv({});
    expect(env.TUYA_BASE_URL).toBe("https://openapi-sg.iotbing.com");
    expect(tuyaConfigFrom(env)).toBeUndefined();
  });

  it("treats empty strings (as in .env.example) as unset", () => {
    const env = parseEnv({ TUYA_ACCESS_ID: "", TUYA_ACCESS_SECRET: "", TUYA_BASE_URL: "" });
    expect(env.TUYA_ACCESS_ID).toBeUndefined();
    expect(env.TUYA_BASE_URL).toBe("https://openapi-sg.iotbing.com");
  });

  it("returns Tuya config when both credentials are set", () => {
    const env = parseEnv({ TUYA_ACCESS_ID: "id", TUYA_ACCESS_SECRET: "secret" });
    expect(tuyaConfigFrom(env)).toMatchObject({ accessId: "id", baseUrl: "https://openapi-sg.iotbing.com" });
  });

  it("rejects non-Tuya or non-https base URLs", () => {
    expect(() => parseEnv({ TUYA_BASE_URL: "https://evil.example.com" })).toThrow(/TUYA_BASE_URL/);
    expect(() => parseEnv({ TUYA_BASE_URL: "http://openapi-sg.iotbing.com" })).toThrow(/TUYA_BASE_URL/);
    expect(() => parseEnv({ TUYA_BASE_URL: "https://openapi-sg.iotbing.com.evil.io" })).toThrow(/TUYA_BASE_URL/);
    // Dots are literal: look-alike hosts must not slip through the allowlist.
    expect(() => parseEnv({ TUYA_BASE_URL: "https://openapi-sg-iotbing-com.evil.io" })).toThrow(/TUYA_BASE_URL/);
    expect(() => parseEnv({ TUYA_BASE_URL: "https://openapi-sgXiotbingXcom" })).toThrow(/TUYA_BASE_URL/);
  });

  it("accepts other regional Tuya hosts", () => {
    expect(parseEnv({ TUYA_BASE_URL: "https://openapi.tuyaeu.com" }).TUYA_BASE_URL).toBe("https://openapi.tuyaeu.com");
  });

  it("does not leak offending values in error messages", () => {
    try {
      parseEnv({ CONFIRMATION_SECRET: "short-secret-value" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("CONFIRMATION_SECRET");
      expect((e as Error).message).not.toContain("short-secret-value");
    }
  });

  it("rejects malformed database URLs without echoing the password", () => {
    try {
      parseEnv({ DATABASE_URL: "mysql://user:hunter2@host/db" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("DATABASE_URL");
      expect((err as Error).message).not.toContain("hunter2");
    }
  });

  it("prefers the pooled database URL for the running app", () => {
    const both = parseEnv({ DATABASE_URL: "postgresql://u:p@direct/db", DATABASE_URL_POOLED: "postgresql://u:p@pooled/db" });
    expect(appDatabaseUrl(both)).toBe("postgresql://u:p@pooled/db");
    expect(appDatabaseUrl(parseEnv({ DATABASE_URL: "postgresql://u:p@direct/db" }))).toBe("postgresql://u:p@direct/db");
    expect(appDatabaseUrl(parseEnv({}))).toBeUndefined();
  });

  it("bounds the token cache TTL and defaults to 5 seconds", () => {
    expect(parseEnv({}).TOKEN_CACHE_TTL_SECONDS).toBe(5);
    expect(parseEnv({ TOKEN_CACHE_TTL_SECONDS: "0" }).TOKEN_CACHE_TTL_SECONDS).toBe(0);
    expect(() => parseEnv({ TOKEN_CACHE_TTL_SECONDS: "-1" })).toThrow(/TOKEN_CACHE_TTL_SECONDS/);
    expect(() => parseEnv({ TOKEN_CACHE_TTL_SECONDS: "9999" })).toThrow(/TOKEN_CACHE_TTL_SECONDS/);
  });

  it("requires HTTPS by default in production only, unless overridden", () => {
    expect(httpsRequired(parseEnv({ NODE_ENV: "production" }))).toBe(true);
    expect(httpsRequired(parseEnv({ NODE_ENV: "development" }))).toBe(false);
    expect(httpsRequired(parseEnv({ NODE_ENV: "production", REQUIRE_HTTPS: "false" }))).toBe(false);
    expect(httpsRequired(parseEnv({ NODE_ENV: "development", REQUIRE_HTTPS: "true" }))).toBe(true);
  });

  it("control is enabled by default and can be switched off; the confirmation secret must be long", () => {
    expect(parseEnv({}).CONTROL_ENABLED).toBe("true");
    expect(parseEnv({ CONTROL_ENABLED: "false" }).CONTROL_ENABLED).toBe("false");
    expect(() => parseEnv({ CONTROL_ENABLED: "maybe" })).toThrow(/CONTROL_ENABLED/);
    expect(() => parseEnv({ CONFIRMATION_SECRET: "x".repeat(31) })).toThrow(/CONFIRMATION_SECRET/);
    expect(parseEnv({ CONFIRMATION_SECRET: "x".repeat(32) }).CONFIRMATION_SECRET).toHaveLength(32);
  });

});
