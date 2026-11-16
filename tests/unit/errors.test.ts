import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, ERROR_META, httpStatusFor, toSafeError } from "@/core/errors";

describe("error model", () => {
  it("defines metadata for every error code", () => {
    for (const code of ERROR_CODES) expect(ERROR_META[code]).toBeDefined();
  });

  it("serializes AppError with stable code, message, retryable and context", () => {
    const err = new AppError("DEVICE_NOT_FOUND", "Device not found.", { context: { deviceId: "abc" } });
    expect(err.toSafe()).toEqual({
      code: "DEVICE_NOT_FOUND",
      message: "Device not found.",
      retryable: false,
      context: { deviceId: "abc" },
    });
    expect(err.httpStatus).toBe(404);
  });

  it("marks rate limiting and timeouts as retryable", () => {
    expect(new AppError("PROVIDER_RATE_LIMITED", "x").retryable).toBe(true);
    expect(new AppError("REQUEST_TIMEOUT", "x").retryable).toBe(true);
  });

  it("collapses unknown errors to INTERNAL_ERROR without leaking details", () => {
    const safe = toSafeError(new Error("db password=hunter2 failed"));
    expect(safe.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(safe)).not.toContain("hunter2");
    expect(httpStatusFor(new Error("x"))).toBe(500);
  });

  it("does not put the cause in the safe output", () => {
    const err = new AppError("PROVIDER_UNAVAILABLE", "Provider down.", { cause: new Error("secret=abc") });
    expect(JSON.stringify(err.toSafe())).not.toContain("secret=abc");
  });
});
