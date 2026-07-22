import { canonicalHash } from "octopus-evidence";
import type {
  SourceBundleDescriptor,
  TrustedVerificationProfile,
  VerificationRunRequest,
  VerificationTenant,
} from "./types.js";
import { InvalidVerificationRequestError } from "./errors.js";

const REQUEST_KEYS = new Set([
  "organisationRef",
  "projectRef",
  "candidateRef",
  "candidateDigest",
  "sourceBundleRef",
  "sourceBundleDigest",
  "verificationProfileRef",
  "verificationProfileVersion",
  "verificationProfileDigest",
  "idempotencyKey",
]);

const FORBIDDEN_KEYS = new Set([
  "task",
  "command",
  "argv",
  "cwd",
  "env",
  "environment",
  "secretRefs",
  "credentials",
  "apiKey",
  "token",
]);

export function parseVerificationRunRequest(value: unknown): VerificationRunRequest {
  try {
    return parseVerificationRunRequestValue(value);
  } catch (error) {
    if (error instanceof InvalidVerificationRequestError) throw error;
    throw new InvalidVerificationRequestError(
      error instanceof Error ? error.message : "invalid verification request",
      { cause: error },
    );
  }
}

function parseVerificationRunRequestValue(value: unknown): VerificationRunRequest {
  const record = strictObject(value, "verification request");
  for (const key of Object.keys(record)) {
    if (!REQUEST_KEYS.has(key)) {
      const description = FORBIDDEN_KEYS.has(key) ? "forbidden" : "unknown";
      throw new Error(`${description} verification request field: ${key}`);
    }
  }
  if (Object.keys(record).length !== REQUEST_KEYS.size) {
    throw new Error("verification request must contain the exact v1 identity fields");
  }
  const request = {
    organisationRef: nonempty(record, "organisationRef"),
    projectRef: nonempty(record, "projectRef"),
    candidateRef: nonempty(record, "candidateRef"),
    candidateDigest: digest(record, "candidateDigest"),
    sourceBundleRef: nonempty(record, "sourceBundleRef"),
    sourceBundleDigest: digest(record, "sourceBundleDigest"),
    verificationProfileRef: nonempty(record, "verificationProfileRef"),
    verificationProfileVersion: immutableVersion(
      nonempty(record, "verificationProfileVersion"),
    ),
    verificationProfileDigest: digest(record, "verificationProfileDigest"),
    idempotencyKey: bounded(nonempty(record, "idempotencyKey"), 256),
  } satisfies VerificationRunRequest;
  for (const [name, ref] of Object.entries({
    organisationRef: request.organisationRef,
    projectRef: request.projectRef,
    candidateRef: request.candidateRef,
    sourceBundleRef: request.sourceBundleRef,
    verificationProfileRef: request.verificationProfileRef,
  })) {
    if (ref.length > 1024 || !ref.includes(":")) {
      throw new Error(`${name} must be a bounded opaque reference`);
    }
  }
  return request;
}

export function assertTenantBinding(
  tenant: VerificationTenant,
  request: VerificationRunRequest,
): void {
  if (
    request.organisationRef !== tenant.organisationRef ||
    request.projectRef !== tenant.projectRef
  ) {
    throw new InvalidVerificationRequestError(
      "verification request identity does not match tenant headers",
    );
  }
}

export function profileCanonicalInput(
  profile: Omit<TrustedVerificationProfile, "digest">,
): unknown {
  return {
    ref: profile.ref,
    version: profile.version,
    sandboxImageDigest: profile.sandboxImageDigest,
    maxDurationMs: profile.maxDurationMs,
    maxChecks: profile.maxChecks,
    checks: profile.checks,
  };
}

export function computeProfileDigest(
  profile: Omit<TrustedVerificationProfile, "digest">,
): string {
  return `sha256:${canonicalHash(profileCanonicalInput(profile) as never)}`;
}

export function computeBundleDigest(
  descriptor: Omit<SourceBundleDescriptor, "sourceBundleDigest">,
): string {
  return `sha256:${canonicalHash(
    {
      schemaVersion: descriptor.schemaVersion,
      organisationRef: descriptor.organisationRef,
      projectRef: descriptor.projectRef,
      sourceBundleRef: descriptor.sourceBundleRef,
      unicodeNormalization: descriptor.unicodeNormalization,
      entries: descriptor.entries,
    } as never,
  )}`;
}

export function assertDigest(value: string, name = "digest"): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase sha256 digest`);
  }
}

export function assertRelativePath(value: string, name = "path"): string {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    value.normalize("NFC") !== value
  ) {
    throw new Error(`${name} is not a canonical NFC relative path`);
  }
  return value;
}

export function assertWorkingDirectory(value: string): string {
  if (value === ".") return value;
  return assertRelativePath(value, "check working directory");
}

export function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonempty(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function digest(record: Record<string, unknown>, key: string): string {
  const value = nonempty(record, key);
  assertDigest(value, key);
  return value;
}

function bounded(value: string, maximum: number): string {
  if (value.length > maximum) throw new Error(`value exceeds ${maximum} characters`);
  return value;
}

function immutableVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("verificationProfileVersion must be an immutable semantic version");
  }
  return value;
}
