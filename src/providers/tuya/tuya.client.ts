import { randomUUID } from "node:crypto";
import type { TuyaConfig } from "@/config/env";
import { AppError } from "@/core/errors";
import { TuyaTokenManager, type TokenSource } from "./tuya.auth";
import { fromHttpStatus, fromTransportError, fromTuyaCode, isTokenError } from "./tuya.errors";
import { buildStringToSign, canonicalUrl, computeSign } from "./tuya.sign";
import { tuyaEnvelopeSchema, tuyaTokenSchema, type TuyaRequest, type TuyaToken } from "./tuya.types";

/** Tuya replies are small JSON documents; anything near this size is not one. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Reads a JSON body while refusing to buffer more than MAX_RESPONSE_BYTES. */
async function readJsonLimited(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new AppError("PROVIDER_UNAVAILABLE", "Tuya returned an oversized response.");
  }
  const reader = res.body?.getReader();
  if (!reader) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AppError("PROVIDER_UNAVAILABLE", "Tuya returned an oversized response.");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface TuyaClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

/**
 * Signed HTTP client for the Tuya Cloud OpenAPI.
 * The base URL comes from validated server config and the path from our own
 * code, so callers (and agents) can never point it at an arbitrary host.
 */
export class TuyaClient {
  readonly tokens: TuyaTokenManager;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(
    private readonly config: TuyaConfig,
    deps: TuyaClientDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.nonce = deps.nonce ?? randomUUID;
    const source: TokenSource = {
      fetchToken: () => this.tokenCall("/v1.0/token", { grant_type: 1 }),
      refreshToken: (rt) => this.tokenCall(`/v1.0/token/${encodeURIComponent(rt)}`),
    };
    this.tokens = new TuyaTokenManager(source, this.now);
  }

  /** Authenticated request. Retries exactly once if Tuya reports the token as expired/invalid. */
  async request<T>(req: TuyaRequest): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const accessToken = await this.tokens.getAccessToken();
      try {
        return (await this.send(req, accessToken)) as T;
      } catch (error) {
        if (attempt === 0 && error instanceof AppError && error.code === "TOKEN_EXPIRED") {
          this.tokens.invalidate(accessToken);
          continue;
        }
        throw error;
      }
    }
  }

  /** Confirms credentials, signature and data center by obtaining a token. Exposes no secrets. */
  async verifyConnection(): Promise<{ connected: true; tokenValidForSeconds: number }> {
    await this.tokens.getAccessToken();
    return { connected: true, tokenValidForSeconds: this.tokens.remainingSeconds() };
  }

  private async tokenCall(path: string, query?: TuyaRequest["query"]): Promise<TuyaToken> {
    const raw = await this.send({ method: "GET", path, ...(query ? { query } : {}) }, undefined);
    const parsed = tuyaTokenSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("PROVIDER_UNAVAILABLE", "Tuya returned an unexpected token response.");
    }
    return parsed.data;
  }

  /** One signed round trip. `accessToken` is undefined for token-management calls. */
  private async send(req: TuyaRequest, accessToken: string | undefined): Promise<unknown> {
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    const t = String(this.now());
    const nonce = this.nonce();
    const stringToSign = buildStringToSign({
      method: req.method,
      body,
      path: req.path,
      query: req.query,
    });
    const sign = computeSign({
      clientId: this.config.accessId,
      secret: this.config.accessSecret,
      t,
      nonce,
      accessToken,
      stringToSign,
    });

    const headers: Record<string, string> = {
      client_id: this.config.accessId,
      sign,
      t,
      nonce,
      sign_method: "HMAC-SHA256",
    };
    if (accessToken) headers.access_token = accessToken;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(this.config.baseUrl + canonicalUrl(req.path, req.query), {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        // Never follow a redirect: it could carry our signed headers (client_id, sign, access_token) to another host.
        redirect: "error",
      });
    } catch (error) {
      throw fromTransportError(error);
    }

    if (res.status >= 500 || res.status === 429) throw fromHttpStatus(res.status);

    let json: unknown;
    try {
      json = await readJsonLimited(res);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw fromHttpStatus(res.status >= 400 ? res.status : 502);
    }

    return unwrap(json);
  }
}

/** Accepts both `{success, result, t}` envelopes and bare result objects. */
function unwrap(json: unknown): unknown {
  const env = tuyaEnvelopeSchema.safeParse(json);
  if (!env.success) throw new AppError("PROVIDER_UNAVAILABLE", "Tuya returned an unexpected response.");
  const { success, code, result } = env.data;
  if (success === false) {
    throw fromTuyaCode(typeof code === "number" ? code : -1);
  }
  if (success === true) return result;
  // Bare object (no `success` field): the result itself, unless it is an error-shaped body.
  if (typeof code === "number" && code !== 0) throw fromTuyaCode(code);
  return env.data;
}

export { isTokenError };
