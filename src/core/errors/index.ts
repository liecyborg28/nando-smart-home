/**
 * Normalized error model shared by REST and MCP.
 * Provider/transport layers translate their failures into AppError so that
 * raw provider responses, signatures and secrets never reach a client.
 */

export const ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_FAILED",
  "DEVICE_NOT_FOUND",
  "DEVICE_OFFLINE",
  "UNSUPPORTED_OPERATION",
  "INVALID_DEVICE_COMMAND",
  // Malformed request (bad query, body, content type). REST only; an extension of the brief's list.
  "INVALID_REQUEST",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "TOKEN_EXPIRED",
  "REQUEST_TIMEOUT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface ErrorMeta {
  httpStatus: number;
  retryable: boolean;
}

export const ERROR_META: Record<ErrorCode, ErrorMeta> = {
  AUTHENTICATION_FAILED: { httpStatus: 401, retryable: false },
  AUTHORIZATION_FAILED: { httpStatus: 403, retryable: false },
  DEVICE_NOT_FOUND: { httpStatus: 404, retryable: false },
  DEVICE_OFFLINE: { httpStatus: 409, retryable: true },
  UNSUPPORTED_OPERATION: { httpStatus: 422, retryable: false },
  INVALID_DEVICE_COMMAND: { httpStatus: 400, retryable: false },
  INVALID_REQUEST: { httpStatus: 400, retryable: false },
  PROVIDER_RATE_LIMITED: { httpStatus: 429, retryable: true },
  PROVIDER_UNAVAILABLE: { httpStatus: 502, retryable: true },
  TOKEN_EXPIRED: { httpStatus: 401, retryable: true },
  REQUEST_TIMEOUT: { httpStatus: 504, retryable: true },
  INTERNAL_ERROR: { httpStatus: 500, retryable: false },
};

/** JSON-safe context only (ids, field names). Never secrets or raw provider bodies. */
export type SafeContext = Record<string, string | number | boolean | null>;

export interface SafeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  context?: SafeContext;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly context: SafeContext | undefined;
  private readonly statusOverride: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { context?: SafeContext; retryable?: boolean; cause?: unknown; httpStatus?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? ERROR_META[code].retryable;
    this.context = options.context;
    this.statusOverride = options.httpStatus;
  }

  /** HTTP status for REST. A specific status (413, 415...) can override the code's default. */
  get httpStatus(): number {
    return this.statusOverride ?? ERROR_META[this.code].httpStatus;
  }

  toSafe(): SafeError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.context ? { context: this.context } : {}),
    };
  }
}

/**
 * Convert any thrown value into a SafeError. Unknown errors are collapsed to a
 * generic INTERNAL_ERROR so internal messages and stacks are not leaked.
 */
export function toSafeError(error: unknown): SafeError {
  if (error instanceof AppError) return error.toSafe();
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred.",
    retryable: false,
  };
}

export function httpStatusFor(error: unknown): number {
  return error instanceof AppError ? error.httpStatus : ERROR_META.INTERNAL_ERROR.httpStatus;
}
