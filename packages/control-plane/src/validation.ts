import type { CreateAgentRunRequest, TenantScope } from "./types.js";

const CREDENTIAL_KEY =
  /^(api[-_]?key|password|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|bearer[-_]?token|private[-_]?key|authorization|credential)$/i;

export class InvalidRunRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRunRequestError";
  }
}

export function validateScope(scope: TenantScope): void {
  requireOpaque("organisationId", scope.organisationId);
  requireOpaque("projectId", scope.projectId);
}

/** Enforces the Run API's secretRef-only credential boundary. */
export function validateCreateRunRequest(request: CreateAgentRunRequest): void {
  requireOpaque("idempotencyKey", request.idempotencyKey);
  requireOpaque("projectRef", request.projectRef);
  if (request.task.trim().length === 0) {
    throw new InvalidRunRequestError("task must not be empty");
  }
  if (request.task.length > 100_000) {
    throw new InvalidRunRequestError("task is too large");
  }
  const names = new Set<string>();
  for (const ref of request.secretRefs ?? []) {
    requireOpaque("secretRefs.name", ref.name);
    requireOpaque("secretRefs.secretRef", ref.secretRef);
    if (names.has(ref.name)) {
      throw new InvalidRunRequestError(`duplicate secretRef name: ${ref.name}`);
    }
    names.add(ref.name);
  }
  inspectForPlaintextCredentials(request, "request");
  validateBudget(request.budget ?? {});
}

function inspectForPlaintextCredentials(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      inspectForPlaintextCredentials(item, `${path}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw new InvalidRunRequestError(
        `plaintext credential field '${path}.${key}' is forbidden; use secretRefs`,
      );
    }
    inspectForPlaintextCredentials(child, `${path}.${key}`);
  }
}

function validateBudget(
  budget: NonNullable<CreateAgentRunRequest["budget"]>,
): void {
  for (const [name, value] of Object.entries(budget)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new InvalidRunRequestError(
        `budget.${name} must be a finite non-negative number`,
      );
    }
  }
}

function requireOpaque(name: string, value: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new InvalidRunRequestError(`${name} must be 1..512 characters`);
  }
}
