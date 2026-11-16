import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EMPTY_BODY_SHA256,
  buildStringToSign,
  canonicalUrl,
  computeSign,
  contentSha256,
} from "@/providers/tuya/tuya.sign";

// Official worked examples from Tuya's "Sign Requests for Cloud Authorization":
// https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g
const DOC = {
  clientId: "1KAD46OrT9HafiKdsXeg",
  secret: "4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC",
  t: "1588925778000",
  nonce: "5138cc3a9033d69856923fd07b491173",
  accessToken: "3f4eda2bdec17232f67c0b188af3eec1",
  signedHeaders: [
    ["area_id", "29a33e8796834b1efa6"],
    ["call_id", "8afdb70ab2ed11eb85290242ac130003"],
  ] as const,
};

describe("Tuya signing", () => {
  it("hashes an empty body to the documented constant", () => {
    expect(contentSha256(undefined)).toBe(EMPTY_BODY_SHA256);
    expect(contentSha256("")).toBe(EMPTY_BODY_SHA256);
  });

  it("reproduces the official token-request signature", () => {
    const stringToSign = buildStringToSign({
      method: "GET",
      path: "/v1.0/token",
      query: { grant_type: 1 },
      signedHeaders: DOC.signedHeaders,
    });
    expect(stringToSign).toBe(
      [
        "GET",
        EMPTY_BODY_SHA256,
        "area_id:29a33e8796834b1efa6\ncall_id:8afdb70ab2ed11eb85290242ac130003\n",
        "/v1.0/token?grant_type=1",
      ].join("\n"),
    );
    expect(computeSign({ clientId: DOC.clientId, secret: DOC.secret, t: DOC.t, nonce: DOC.nonce, stringToSign })).toBe(
      "9E48A3E93B302EEECC803C7241985D0A34EB944F40FB573C7B5C2A82158AF13E",
    );
  });

  it("reproduces the official business-API signature (token included, sorted query)", () => {
    const stringToSign = buildStringToSign({
      method: "GET",
      path: "/v2.0/apps/schema/users",
      // Deliberately unsorted: canonicalisation must sort keys ascending.
      query: { page_size: 50, page_no: 1 },
      signedHeaders: DOC.signedHeaders,
    });
    expect(
      computeSign({
        clientId: DOC.clientId,
        secret: DOC.secret,
        t: DOC.t,
        nonce: DOC.nonce,
        accessToken: DOC.accessToken,
        stringToSign,
      }),
    ).toBe("AE4481C692AA80B25F3A7E12C3A5FD9BBF6251539DD78E565A1A72A508A88784");
  });

  it("uses an empty header block (blank line) when no headers are signed", () => {
    expect(buildStringToSign({ method: "get", path: "/v1.0/x" })).toBe(`GET\n${EMPTY_BODY_SHA256}\n\n/v1.0/x`);
  });

  it("returns bare path without '?' when there is no query; drops undefined values", () => {
    expect(canonicalUrl("/a", undefined)).toBe("/a");
    expect(canonicalUrl("/a", {})).toBe("/a");
    expect(canonicalUrl("/a", { b: 2, a: undefined, c: "x" })).toBe("/a?b=2&c=x");
  });

  it("hashes a JSON body into stringToSign", () => {
    const body = '{"commands":[{"code":"switch_1","value":true}]}';
    const s = buildStringToSign({ method: "POST", path: "/p", body });
    expect(s.split("\n")[1]).toBe(contentSha256(body));
    expect(s.split("\n")[1]).not.toBe(EMPTY_BODY_SHA256);
  });

  it("omits access_token for token requests and includes it otherwise", () => {
    const base = { clientId: "c", secret: "s", t: "1", nonce: "n", stringToSign: "X" };
    const manual = (str: string) => createHmac("sha256", "s").update(str).digest("hex").toUpperCase();
    expect(computeSign(base)).toBe(manual("c1nX"));
    expect(computeSign({ ...base, accessToken: "tok" })).toBe(manual("ctok1nX"));
  });
});
