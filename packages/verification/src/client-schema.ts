import { canonicalHash, verifyEvidence, type Evidence } from "octopus-evidence";
import {
  VERIFICATION_STATES,
  type VerificationArtifact,
  type VerificationCheckResult,
  type VerificationEvidenceEnvelope,
  type VerificationEvent,
  type VerificationFailure,
  type VerificationIdentity,
  type VerificationLease,
  type VerificationRun,
  type VerificationToolIdentity,
  type VerificationVerdict,
} from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

/** Runtime validation for data crossing the public HTTP client boundary. */
export function parseVerificationRunResponse(value: unknown): VerificationRun {
  const run = record(value, "verification run");
  assertIdentity(run, "verification run");
  nonempty(run, "runRef");
  nonempty(run, "idempotencyKey");
  enumValue(run, "state", VERIFICATION_STATES);
  positiveInteger(run, "version");
  positiveInteger(run, "attempt");
  decimal(run, "eventCursor");
  timestamp(run, "createdAt");
  timestamp(run, "updatedAt");
  optionalTimestamp(run, "startedAt");
  optionalTimestamp(run, "finishedAt");
  optionalString(run, "sandboxRef");

  const checks = array(run, "checks").map(parseCheckResult);
  unique(
    checks.map((check) => check.checkRef),
    "verification checkRef",
  );
  const verdict = optionalRecord(run, "verdict", parseVerdict);
  const failure = optionalRecord(run, "failure", parseFailure);
  optionalRecord(run, "lease", parseLease);

  const state = run["state"];
  if (state === "completed" && verdict === undefined) {
    throw new Error("completed verification run is missing its verdict");
  }
  if (state === "failed" && failure === undefined) {
    throw new Error(
      "operationally failed verification run is missing its failure",
    );
  }
  if (state !== "completed" && verdict !== undefined) {
    throw new Error("only a completed verification run may contain a verdict");
  }
  if (state !== "failed" && failure !== undefined) {
    throw new Error(
      "only an operationally failed verification run may contain a failure",
    );
  }
  if (TERMINAL_STATES.has(String(state)) && run["finishedAt"] === undefined) {
    throw new Error("terminal verification run is missing finishedAt");
  }
  return value as VerificationRun;
}

export function parseVerificationEventResponse(
  value: unknown,
): VerificationEvent {
  const event = record(value, "verification event");
  assertTenant(event, "verification event");
  nonempty(event, "id");
  nonempty(event, "runRef");
  decimal(event, "cursor");
  const type = nonempty(event, "type");
  if (!type.startsWith("verification.")) {
    throw new Error("verification event type is outside the v1 namespace");
  }
  timestamp(event, "createdAt");
  verificationEventIdentity(value as VerificationEvent);
  return value as VerificationEvent;
}

export function verificationEventIdentity(
  event: VerificationEvent,
): VerificationIdentity {
  const data = record(event.data, "verification event data");
  const identity = record(data["identity"], "verification event identity");
  assertIdentity(identity, "verification event identity");
  return identity as unknown as VerificationIdentity;
}

export function parseVerificationEvidenceResponse(
  value: unknown,
): VerificationEvidenceEnvelope {
  const envelope = record(value, "verification Evidence envelope");
  assertTenant(envelope, "verification Evidence envelope");
  const ref = nonempty(envelope, "ref");
  if (!ref.startsWith("evidence:")) {
    throw new Error("verification Evidence ref is not opaque");
  }
  const envelopeDigest = digest(envelope, "digest");
  const evidence = envelope["evidence"] as Evidence;
  if (!verifyEvidence(evidence)) {
    throw new Error(
      "verification Evidence failed local integrity verification",
    );
  }
  const computed = `sha256:${canonicalHash(evidence as never)}`;
  if (envelopeDigest !== computed) {
    throw new Error("verification Evidence canonical digest mismatch");
  }
  const verifier = record(
    envelope["verifier"],
    "verification Evidence verifier",
  );
  if (
    verifier["implementation"] !== "octopus-evidence" ||
    verifier["version"] !== "0.2.0" ||
    verifier["integrityVerified"] !== true
  ) {
    throw new Error("verification Evidence verifier metadata is invalid");
  }
  return value as VerificationEvidenceEnvelope;
}

export function assertSameIdentity(
  actual: VerificationIdentity,
  expected: VerificationIdentity,
  name = "verification identity",
): void {
  for (const key of IDENTITY_KEYS) {
    if (actual[key] !== expected[key])
      throw new Error(`${name} mismatch: ${key}`);
  }
}

function parseCheckResult(value: unknown): VerificationCheckResult {
  const result = record(value, "verification check result");
  nonempty(result, "checkRef");
  boolean(result, "required");
  enumValue(result, "outcome", ["passed", "failed", "skipped"] as const);
  nonnegativeInteger(result, "durationMs");
  timestamp(result, "startedAt");
  timestamp(result, "finishedAt");
  optionalInteger(result, "exitCode");
  nonempty(result, "resultCode");
  parseToolIdentity(result["tool"]);
  array(result, "artifacts").map(parseArtifact);
  const evidenceRef = nonempty(result, "evidenceRef");
  if (!evidenceRef.startsWith("evidence:")) {
    throw new Error("verification check Evidence ref is not opaque");
  }
  digest(result, "evidenceDigest");
  return value as VerificationCheckResult;
}

function parseArtifact(value: unknown): VerificationArtifact {
  const artifact = record(value, "verification artifact");
  nonempty(artifact, "ref");
  digest(artifact, "digest");
  nonempty(artifact, "kind");
  nonempty(artifact, "mediaType");
  nonnegativeInteger(artifact, "size");
  return value as VerificationArtifact;
}

function parseToolIdentity(value: unknown): VerificationToolIdentity {
  const tool = record(value, "verification tool identity");
  nonempty(tool, "name");
  nonempty(tool, "version");
  digest(tool, "imageDigest");
  return value as VerificationToolIdentity;
}

function parseVerdict(value: Record<string, unknown>): VerificationVerdict {
  const outcome = enumValue(value, "outcome", ["passed", "failed"] as const);
  const required = stringArray(value, "requiredChecks");
  const passed = stringArray(value, "passedRequiredChecks");
  const failed = stringArray(value, "failedRequiredChecks");
  unique(required, "required check");
  unique(passed, "passed required check");
  unique(failed, "failed required check");
  if (passed.some((check) => failed.includes(check))) {
    throw new Error(
      "verification verdict contains contradictory required checks",
    );
  }
  if (
    required.length !== passed.length + failed.length ||
    required.some((check) => !passed.includes(check) && !failed.includes(check))
  ) {
    throw new Error("verification verdict does not cover every required check");
  }
  if ((outcome === "passed") !== (failed.length === 0)) {
    throw new Error(
      "verification verdict outcome contradicts required-check coverage",
    );
  }
  const evidenceRef = nonempty(value, "evidenceRef");
  if (!evidenceRef.startsWith("evidence:")) {
    throw new Error("verification verdict Evidence ref is not opaque");
  }
  digest(value, "evidenceDigest");
  return value as unknown as VerificationVerdict;
}

function parseFailure(value: Record<string, unknown>): VerificationFailure {
  nonempty(value, "code");
  nonempty(value, "message");
  boolean(value, "retryable");
  return value as unknown as VerificationFailure;
}

function parseLease(value: Record<string, unknown>): VerificationLease {
  nonempty(value, "ownerId");
  positiveInteger(value, "fencingToken");
  timestamp(value, "expiresAt");
  return value as unknown as VerificationLease;
}

function assertIdentity(value: Record<string, unknown>, name: string): void {
  assertTenant(value, name);
  nonempty(value, "candidateRef");
  digest(value, "candidateDigest");
  nonempty(value, "sourceBundleRef");
  digest(value, "sourceBundleDigest");
  nonempty(value, "verificationProfileRef");
  nonempty(value, "verificationProfileVersion");
  digest(value, "verificationProfileDigest");
}

function assertTenant(value: Record<string, unknown>, name: string): void {
  const organisationRef = nonempty(value, "organisationRef");
  const projectRef = nonempty(value, "projectRef");
  if (!organisationRef.includes(":") || !projectRef.includes(":")) {
    throw new Error(`${name} tenant references are invalid`);
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(
  value: Record<string, unknown>,
  key: string,
): readonly unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new Error(`${key} must be an array`);
  return field;
}

function stringArray(value: Record<string, unknown>, key: string): string[] {
  return array(value, key).map((entry) => {
    if (typeof entry !== "string" || entry === "")
      throw new Error(`${key} must contain strings`);
    return entry;
  });
}

function nonempty(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "")
    throw new Error(`${key} must be a non-empty string`);
  return field;
}

function optionalString(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined) nonempty(value, key);
}

function digest(value: Record<string, unknown>, key: string): string {
  const field = nonempty(value, key);
  if (!DIGEST.test(field))
    throw new Error(`${key} must be a lowercase sha256 digest`);
  return field;
}

function decimal(value: Record<string, unknown>, key: string): string {
  const field = nonempty(value, key);
  if (!DECIMAL.test(field))
    throw new Error(`${key} must be a canonical decimal cursor`);
  return field;
}

function boolean(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") throw new Error(`${key} must be boolean`);
  return field;
}

function positiveInteger(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || Number(field) < 1)
    throw new Error(`${key} must be a positive integer`);
  return Number(field);
}

function nonnegativeInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || Number(field) < 0)
    throw new Error(`${key} must be a non-negative integer`);
  return Number(field);
}

function optionalInteger(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && !Number.isSafeInteger(value[key])) {
    throw new Error(`${key} must be an integer`);
  }
}

function timestamp(value: Record<string, unknown>, key: string): string {
  const field = nonempty(value, key);
  if (!Number.isFinite(Date.parse(field)))
    throw new Error(`${key} must be an RFC 3339 timestamp`);
  return field;
}

function optionalTimestamp(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined) timestamp(value, key);
}

function enumValue<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const field = value[key];
  if (typeof field !== "string" || !allowed.includes(field)) {
    throw new Error(`${key} is outside the v1 protocol`);
  }
  return field as T[number];
}

function optionalRecord<T>(
  value: Record<string, unknown>,
  key: string,
  parse: (recordValue: Record<string, unknown>) => T,
): T | undefined {
  if (value[key] === undefined) return undefined;
  return parse(record(value[key], key));
}

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`duplicate ${name}`);
}

const IDENTITY_KEYS = [
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
