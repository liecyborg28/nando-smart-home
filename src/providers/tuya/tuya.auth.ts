import { AppError } from "@/core/errors";
import type { TuyaToken } from "./tuya.types";

/**
 * Token lifecycle for the Tuya Cloud API.
 *
 * - Tokens are cached in memory only (never logged, never returned to clients).
 * - Concurrent callers share ONE in-flight acquisition (no refresh races).
 * - A token is treated as expired EXPIRY_MARGIN_MS early to avoid using it at the edge.
 * - Refresh is attempted first; if it fails, a fresh token is requested instead.
 */

export interface TokenSource {
  /** GET /v1.0/token?grant_type=1 */
  fetchToken(): Promise<TuyaToken>;
  /** GET /v1.0/token/{refresh_token} */
  refreshToken(refreshToken: string): Promise<TuyaToken>;
}

export const EXPIRY_MARGIN_MS = 60_000;

interface State {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

export class TuyaTokenManager {
  private state: State | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly source: TokenSource,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    const s = this.state;
    if (s && this.now() < s.expiresAtMs - EXPIRY_MARGIN_MS) return s.accessToken;
    // Single-flight: every concurrent caller awaits the same acquisition.
    this.inflight ??= this.acquire().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * Drop the cached token after Tuya rejected it. Only clears if it is still the
   * token that failed, so a concurrent refresh that already replaced it is kept.
   */
  invalidate(failedAccessToken: string): void {
    if (this.state?.accessToken === failedAccessToken) {
      // Keep the refresh token so the next acquire can try to refresh first.
      this.state = { ...this.state, expiresAtMs: 0 };
    }
  }

  /** Seconds the current token remains valid, or 0. For status reporting only. */
  remainingSeconds(): number {
    return this.state ? Math.max(0, Math.floor((this.state.expiresAtMs - this.now()) / 1000)) : 0;
  }

  private async acquire(): Promise<string> {
    const previous = this.state;
    let token: TuyaToken | undefined;
    if (previous?.refreshToken) {
      try {
        token = await this.source.refreshToken(previous.refreshToken);
      } catch (error) {
        // Rate limiting or an outage will not be fixed by asking for a brand-new token.
        if (error instanceof AppError && (error.code === "PROVIDER_RATE_LIMITED" || error.code === "REQUEST_TIMEOUT")) {
          throw error;
        }
      }
    }
    token ??= await this.source.fetchToken();
    this.state = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAtMs: this.now() + token.expire_time * 1000,
    };
    return token.access_token;
  }
}
