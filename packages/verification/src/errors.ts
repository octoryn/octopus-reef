export class VerificationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationConflictError";
  }
}

export class VerificationAuthenticationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VerificationAuthenticationError";
  }
}

export class VerificationAuthorizationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VerificationAuthorizationError";
  }
}

export class InvalidVerificationRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidVerificationRequestError";
  }
}

export class VerificationNotFoundError extends Error {
  constructor(message = "verification run was not found") {
    super(message);
    this.name = "VerificationNotFoundError";
  }
}

export class VerificationInfrastructureError extends Error {
  readonly retryable = true;

  constructor(
    message: string,
    readonly code = "VERIFICATION_INFRASTRUCTURE_FAILURE",
    readonly status: 500 | 503 = 500,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VerificationInfrastructureError";
  }
}

export class VerificationInfrastructureUnavailableError extends VerificationInfrastructureError {
  constructor(
    message = "verification infrastructure is temporarily unavailable",
    options?: ErrorOptions,
  ) {
    super(message, "VERIFICATION_INFRASTRUCTURE_UNAVAILABLE", 503, options);
    this.name = "VerificationInfrastructureUnavailableError";
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

export function verificationInfrastructureStatus(error: unknown): 500 | 503 {
  if (error instanceof VerificationInfrastructureError) return error.status;
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current === null || typeof current !== "object") break;
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return 503;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return 500;
}
