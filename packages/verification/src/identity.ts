import type { VerificationIdentity, VerificationRunIdentity } from "./types.js";
import { assertDigest } from "./validation.js";

export const VERIFICATION_IDENTITY_KEYS = [
  "organisationRef",
  "projectRef",
  "candidateRef",
  "candidateDigest",
  "sourceBundleRef",
  "sourceBundleDigest",
  "verificationProfileRef",
  "verificationProfileVersion",
  "verificationProfileDigest",
] as const;

export const VERIFICATION_RUN_IDENTITY_KEYS = [
  ...VERIFICATION_IDENTITY_KEYS,
  "runRef",
] as const;

export function verificationIdentity(
  value: VerificationIdentity,
): VerificationIdentity {
  return {
    organisationRef: value.organisationRef,
    projectRef: value.projectRef,
    candidateRef: value.candidateRef,
    candidateDigest: value.candidateDigest,
    sourceBundleRef: value.sourceBundleRef,
    sourceBundleDigest: value.sourceBundleDigest,
    verificationProfileRef: value.verificationProfileRef,
    verificationProfileVersion: value.verificationProfileVersion,
    verificationProfileDigest: value.verificationProfileDigest,
  };
}

export function verificationRunIdentity(
  value: VerificationRunIdentity,
): VerificationRunIdentity {
  return {
    ...verificationIdentity(value),
    runRef: value.runRef,
  };
}

export function assertVerificationRunIdentity(
  actual: VerificationRunIdentity,
  expected: VerificationRunIdentity,
  name = "verification run identity",
): void {
  for (const key of VERIFICATION_RUN_IDENTITY_KEYS) {
    if (actual[key] !== expected[key]) {
      throw new Error(`${name} mismatch: ${key}`);
    }
  }
}

export function parseVerificationRunIdentity(
  value: unknown,
  name = "verification run identity",
): VerificationRunIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const identity = {
    organisationRef: opaque(record, "organisationRef", name),
    projectRef: opaque(record, "projectRef", name),
    candidateRef: opaque(record, "candidateRef", name),
    candidateDigest: digest(record, "candidateDigest", name),
    sourceBundleRef: opaque(record, "sourceBundleRef", name),
    sourceBundleDigest: digest(record, "sourceBundleDigest", name),
    verificationProfileRef: opaque(record, "verificationProfileRef", name),
    verificationProfileVersion: text(
      record,
      "verificationProfileVersion",
      name,
    ),
    verificationProfileDigest: digest(
      record,
      "verificationProfileDigest",
      name,
    ),
    runRef: opaque(record, "runRef", name),
  } satisfies VerificationRunIdentity;
  return identity;
}

export function bindVerificationEventData(
  value: unknown,
  expected: VerificationRunIdentity,
): Record<string, unknown> {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { detail: value };
  if (record["identity"] !== undefined) {
    const actual = parseVerificationRunIdentity(
      record["identity"],
      "verification event data identity",
    );
    assertVerificationRunIdentity(
      actual,
      expected,
      "verification event data identity",
    );
  }
  return { ...record, identity: verificationRunIdentity(expected) };
}

function text(
  record: Record<string, unknown>,
  key: string,
  name: string,
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${name} ${key} is invalid`);
  }
  return value;
}

function opaque(
  record: Record<string, unknown>,
  key: string,
  name: string,
): string {
  const value = text(record, key, name);
  if (value.startsWith("/") || value.includes("://") || value.includes("\\")) {
    throw new Error(`${name} ${key} must be a bounded opaque reference`);
  }
  return value;
}

function digest(
  record: Record<string, unknown>,
  key: string,
  name: string,
): string {
  const value = text(record, key, name);
  assertDigest(value, `${name} ${key}`);
  return value;
}
