export type ErrorCode =
  | "CONFIGURATION_ERROR"
  | "INVALID_INPUT"
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "REQUEST_BUDGET_EXHAUSTED"
  | "UPSTREAM_REJECTED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_INVALID_RESPONSE"
  | "UPSTREAM_REDIRECT"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
}

export class ConnectorError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }

  toPublic(): PublicError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined
        ? {}
        : { retry_after_ms: this.retryAfterMs }),
    };
  }
}
