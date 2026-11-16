import { createHash, createHmac } from "node:crypto";

/**
 * Tuya Cloud OpenAPI request signing (HMAC-SHA256).
 * Source: Tuya docs, "Sign Requests for Cloud Authorization"
 * https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g
 *
 *   token requests:    str = client_id + t + nonce + stringToSign
 *   business requests: str = client_id + access_token + t + nonce + stringToSign
 *   sign = HMAC-SHA256(str, secret) as UPPERCASE hex
 *
 *   stringToSign = METHOD "\n" Content-SHA256 "\n" signedHeaders "\n" URL
 *   URL          = path ["?" k1=v1 "&" k2=v2 ...]  (keys sorted ascending)
 */

/** SHA-256 of an empty body, as documented. */
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function contentSha256(body: string | undefined): string {
  return createHash("sha256")
    .update(body ?? "", "utf8")
    .digest("hex");
}

export type Query = Record<string, string | number | boolean | undefined>;

/** Canonical query string: undefined dropped, keys sorted ascending. Same string is signed and sent. */
export function canonicalQuery(query: Query | undefined): string {
  if (!query) return "";
  return Object.keys(query)
    .filter((k) => query[k] !== undefined)
    .sort()
    .map((k) => `${k}=${String(query[k])}`)
    .join("&");
}

export function canonicalUrl(path: string, query: Query | undefined): string {
  const qs = canonicalQuery(query);
  return qs ? `${path}?${qs}` : path;
}

export interface StringToSignInput {
  method: string;
  /** Raw request body (JSON string) or undefined when there is none. */
  body?: string | undefined;
  /** Headers named in Signature-Headers, in that order. Empty when unused. */
  signedHeaders?: ReadonlyArray<readonly [string, string]>;
  path: string;
  query?: Query | undefined;
}

export function buildStringToSign(input: StringToSignInput): string {
  const headerBlock = (input.signedHeaders ?? []).map(([k, v]) => `${k}:${v}\n`).join("");
  return [input.method.toUpperCase(), contentSha256(input.body), headerBlock, canonicalUrl(input.path, input.query)].join(
    "\n",
  );
}

export interface SignInput {
  clientId: string;
  secret: string;
  /** 13-digit millisecond timestamp, as a string. */
  t: string;
  nonce: string;
  /** Omit for token requests (get/refresh token). */
  accessToken?: string | undefined;
  stringToSign: string;
}

export function computeSign(input: SignInput): string {
  const str = input.clientId + (input.accessToken ?? "") + input.t + input.nonce + input.stringToSign;
  return createHmac("sha256", input.secret).update(str, "utf8").digest("hex").toUpperCase();
}
