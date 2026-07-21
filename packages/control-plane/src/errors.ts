/** A valid request that conflicts with the durable AgentRun state. */
export class RunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConflictError";
  }
}

/** Base error for failures callers may safely retry with the same key. */
export class InfrastructureError extends Error {
  readonly retryable = true;

  constructor(
    message: string,
    readonly code = "INFRASTRUCTURE_FAILURE",
    readonly status: 500 | 503 = 500,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InfrastructureError";
  }
}

export class InfrastructureUnavailableError extends InfrastructureError {
  constructor(
    message = "control-plane infrastructure is temporarily unavailable",
    options?: ErrorOptions,
  ) {
    super(message, "INFRASTRUCTURE_UNAVAILABLE", 503, options);
    this.name = "InfrastructureUnavailableError";
  }
}

/** PostgreSQL/SQS/etc. adapters use this for semantic key collisions. */
export class PersistenceIdempotencyConflictError extends RunConflictError {
  constructor(idempotencyKey: string) {
    super(
      `idempotency key was reused with a different durable operation: ${idempotencyKey}`,
    );
    this.name = "PersistenceIdempotencyConflictError";
  }
}

const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

export function infrastructureHttpStatus(error: unknown): 500 | 503 {
  if (error instanceof InfrastructureError) return error.status;
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current === null || typeof current !== "object") break;
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return 503;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return 500;
}
