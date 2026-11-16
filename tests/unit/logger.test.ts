import { describe, expect, it } from "vitest";
import { REDACTED, createLogger, redact } from "@/lib/logger";

describe("redact", () => {
  it("masks sensitive keys recursively", () => {
    const out = redact({
      client_id: "keep",
      client_secret: "s3cret",
      headers: { Authorization: "Bearer abc", sign: "SIG", "access_token": "tok" },
      list: [{ password: "p" }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/s3cret|Bearer abc|SIG|tok"|"p"/);
    expect(out.client_id).toBe("keep");
    expect((out.headers as Record<string, unknown>).Authorization).toBe(REDACTED);
  });

  it("reduces Error objects to name and message (no stack)", () => {
    const out = redact(new Error("boom")) as Record<string, unknown>;
    expect(out).toEqual({ name: "Error", message: "boom" });
  });
});

describe("createLogger", () => {
  it("writes redacted JSON lines and honours level", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", sink: (l) => lines.push(l) });
    log.debug("hidden");
    log.info("hello", { access_token: "tok", deviceId: "d1" });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: "info", msg: "hello", deviceId: "d1", access_token: REDACTED });
  });

  it("child loggers inherit bindings", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) }).child({ requestId: "r1" });
    log.info("x");
    expect(JSON.parse(lines[0]!).requestId).toBe("r1");
  });
});
