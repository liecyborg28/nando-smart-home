import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/core/errors";
import { EXPIRY_MARGIN_MS, TuyaTokenManager, type TokenSource } from "@/providers/tuya/tuya.auth";
import type { TuyaToken } from "@/providers/tuya/tuya.types";

function tok(n: number, expire_time = 7200): TuyaToken {
  return { access_token: `at-${n}`, refresh_token: `rt-${n}`, expire_time };
}

function setup(overrides: Partial<TokenSource> = {}) {
  let clock = 1_000_000;
  let n = 0;
  const source = {
    fetchToken: vi.fn(async () => tok(++n)),
    refreshToken: vi.fn(async () => tok(++n)),
    ...overrides,
  } satisfies TokenSource;
  const mgr = new TuyaTokenManager(source, () => clock);
  return { mgr, source, advance: (ms: number) => (clock += ms) };
}

describe("TuyaTokenManager", () => {
  it("fetches once and serves the cached token afterwards", async () => {
    const { mgr, source } = setup();
    expect(await mgr.getAccessToken()).toBe("at-1");
    expect(await mgr.getAccessToken()).toBe("at-1");
    expect(source.fetchToken).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent callers (no refresh race)", async () => {
    const { mgr, source } = setup({
      fetchToken: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return tok(1);
      }),
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => mgr.getAccessToken()));
    expect(new Set(results)).toEqual(new Set(["at-1"]));
    expect(source.fetchToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes with the refresh token once the token is within the expiry margin", async () => {
    const { mgr, source, advance } = setup();
    await mgr.getAccessToken();
    advance(7200 * 1000 - EXPIRY_MARGIN_MS + 1);
    expect(await mgr.getAccessToken()).toBe("at-2");
    expect(source.refreshToken).toHaveBeenCalledWith("rt-1");
    expect(source.fetchToken).toHaveBeenCalledTimes(1);
  });

  it("does not refresh before the margin", async () => {
    const { mgr, source, advance } = setup();
    await mgr.getAccessToken();
    advance(7200 * 1000 - EXPIRY_MARGIN_MS - 1000);
    await mgr.getAccessToken();
    expect(source.refreshToken).not.toHaveBeenCalled();
  });

  it("falls back to a fresh token when refresh fails", async () => {
    const { mgr, source, advance } = setup({
      refreshToken: vi.fn(async () => {
        throw new AppError("TOKEN_EXPIRED", "refresh token rejected");
      }),
    });
    await mgr.getAccessToken();
    advance(7200 * 1000);
    expect(await mgr.getAccessToken()).toBe("at-2");
    expect(source.fetchToken).toHaveBeenCalledTimes(2);
  });

  it("does not hammer Tuya with a new token request when rate limited", async () => {
    const { mgr, source, advance } = setup({
      refreshToken: vi.fn(async () => {
        throw new AppError("PROVIDER_RATE_LIMITED", "slow down");
      }),
    });
    await mgr.getAccessToken();
    advance(7200 * 1000);
    await expect(mgr.getAccessToken()).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    expect(source.fetchToken).toHaveBeenCalledTimes(1);
  });

  it("allows retry after a failed acquisition (in-flight state is cleared)", async () => {
    let fail = true;
    const { mgr } = setup({
      fetchToken: vi.fn(async () => {
        if (fail) throw new AppError("PROVIDER_UNAVAILABLE", "down");
        return tok(9);
      }),
    });
    await expect(mgr.getAccessToken()).rejects.toBeInstanceOf(AppError);
    fail = false;
    expect(await mgr.getAccessToken()).toBe("at-9");
  });

  it("invalidate() forces a refresh only if the failed token is still current", async () => {
    const { mgr, source } = setup();
    const first = await mgr.getAccessToken();
    mgr.invalidate("some-other-token");
    expect(await mgr.getAccessToken()).toBe(first);
    expect(source.refreshToken).not.toHaveBeenCalled();

    mgr.invalidate(first);
    expect(await mgr.getAccessToken()).toBe("at-2");
    expect(source.refreshToken).toHaveBeenCalledWith("rt-1");
  });
});
