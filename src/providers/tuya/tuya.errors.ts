import { AppError } from "@/core/errors";

/**
 * Translate Tuya failures into the normalized AppError model.
 * Tuya error codes: https://developer.tuya.com/en/docs/iot/error-code?id=K989ruxx88swc
 *
 * Only the numeric Tuya code is kept as context. The provider's `msg` text and
 * raw bodies are deliberately dropped so nothing sensitive reaches a client.
 */

const TOKEN_CODES = new Set([1002, 1010, 1011, 1012, 1400]);
const AUTH_CODES = new Set([1004, 1005, 1013]);
const PERMISSION_CODES = new Set([1106, 1114, 28841105, 60009001]);
const RATE_LIMIT_CODES = new Set([1110, 1113, 1199]);

// Device-level codes (Tuya error-code page): 2001 offline, 2010 not exist, 2008/2009 not supported.
const OFFLINE_CODES = new Set([2001, 40000801]);
const NOT_FOUND_CODES = new Set([2010, 40000901, 2016, 2054]);
// 2003 function not supported; IR codes 2050/2052/2055 (key/temperature/device not supported).
const UNSUPPORTED_CODES = new Set([2003, 2008, 2009, 2050, 2052, 2055]);
// Malformed command or value: 40000308, 40000003, 40004002, 1101, 1109, 1103.
const INVALID_COMMAND_CODES = new Set([1101, 1103, 1109, 40000003, 40000308, 40004002]);

export function isTokenError(code: number): boolean {
  return TOKEN_CODES.has(code);
}

export function fromTuyaCode(code: number): AppError {
  const context = { providerCode: code };
  if (OFFLINE_CODES.has(code)) return new AppError("DEVICE_OFFLINE", "The device is offline.", { context });
  if (NOT_FOUND_CODES.has(code)) return new AppError("DEVICE_NOT_FOUND", "Device not found.", { context });
  if (INVALID_COMMAND_CODES.has(code))
    return new AppError("INVALID_DEVICE_COMMAND", "The provider rejected the command or its value.", { context });
  if (code === 2051)
    return new AppError("PROVIDER_UNAVAILABLE", "The provider could not send the infrared command. Try again.", { context, retryable: true });
  if (UNSUPPORTED_CODES.has(code))
    return new AppError("UNSUPPORTED_OPERATION", "The device does not support this operation.", { context });
  if (TOKEN_CODES.has(code)) return new AppError("TOKEN_EXPIRED", "Tuya access token is expired or invalid.", { context });
  if (AUTH_CODES.has(code))
    return new AppError("AUTHENTICATION_FAILED", "Tuya rejected the request credentials, signature or timestamp.", {
      context,
    });
  if (PERMISSION_CODES.has(code))
    return new AppError("AUTHORIZATION_FAILED", "The Tuya project is not authorized for this API or device.", { context });
  if (RATE_LIMIT_CODES.has(code))
    return new AppError("PROVIDER_RATE_LIMITED", "Tuya rate limit reached. Try again later.", { context });
  return new AppError("PROVIDER_UNAVAILABLE", "Tuya returned an unexpected error.", { context, retryable: false });
}

export function fromHttpStatus(status: number): AppError {
  const context = { httpStatus: status };
  if (status === 429) return new AppError("PROVIDER_RATE_LIMITED", "Tuya rate limit reached. Try again later.", { context });
  return new AppError("PROVIDER_UNAVAILABLE", "Tuya is temporarily unavailable.", { context });
}

export function fromTransportError(error: unknown): AppError {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError")
    return new AppError("REQUEST_TIMEOUT", "The request to Tuya timed out.");
  return new AppError("PROVIDER_UNAVAILABLE", "Could not reach Tuya.");
}
