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
  type VerificationMaterialization,
  type VerificationRun,
  type VerificationRunIdentity,
  type VerificationToolIdentity,
  type VerificationVerdict,
} from "./types.js";
import { parseVerificationDecimalCursor } from "./cursor.js";
import {
  VERIFICATION_IDENTITY_KEYS,
  assertVerificationRunIdentity,
  parseVerificationRunIdentity,
} from "./identity.js";
import {
  evidenceReference,
  parseArtifactReference,
  parseEvidenceReference,
  verificationEvidenceBinding,
} from "./evidence.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

/** Runtime validation for data crossing the public HTTP client boundary. */
export function parseVerificationRunResponse(value: unknown): VerificationRun {
  const run = record(value, "verification run");
  const runIdentity = parseVerificationRunIdentity(run, "verification run");
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
  const materialization = optionalRecord(
    run,
    "materialization",
    parseVerificationMaterializationResponse,
  );
  if (
    materialization !== undefined &&
    materialization.authoritativeSourceBundleDigest !==
      runIdentity.sourceBundleDigest
  ) {
    throw new Error(
      "verification materialization/source bundle digest mismatch",
    );
  }

  const checks = array(run, "checks").map(parseVerificationCheckResultResponse);
  for (const check of checks) {
    assertVerificationRunIdentity(
      check.identity,
      runIdentity,
      `verification check ${check.checkRef} identity`,
    );
  }
  unique(
    checks.map((check) => check.checkRef),
    "verification checkRef",
  );
  const verdict = optionalRecord(run, "verdict", parseVerdict);
  if (verdict !== undefined) {
    assertVerificationRunIdentity(
      verdict.identity,
      runIdentity,
      "verification verdict identity",
    );
  }
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
  const runRef = nonempty(event, "runRef");
  const identity = parseVerificationRunIdentity(
    event["identity"],
    "verification event identity",
  );
  assertTopLevelRunIdentity(event, identity, "verification event");
  if (runRef !== identity.runRef) {
    throw new Error("verification event runRef identity mismatch");
  }
  decimal(event, "cursor");
  const type = nonempty(event, "type");
  if (!type.startsWith("verification.")) {
    throw new Error("verification event type is outside the v1 namespace");
  }
  timestamp(event, "createdAt");
  const data = record(event["data"], "verification event data");
  const dataIdentity = parseVerificationRunIdentity(
    data["identity"],
    "verification event data identity",
  );
  assertVerificationRunIdentity(
    dataIdentity,
    identity,
    "verification event data identity",
  );
  if (type === "verification.check_completed") {
    const result = parseVerificationCheckResultResponse(data["result"]);
    assertVerificationRunIdentity(
      result.identity,
      identity,
      "verification check event identity",
    );
  }
  if (type === "verification.completed") {
    const verdict = parseVerdict(
      record(data["verdict"], "verification completed event verdict"),
    );
    assertVerificationRunIdentity(
      verdict.identity,
      identity,
      "verification completed event identity",
    );
  }
  if (type === "verification.materialized") {
    const materialization = parseVerificationMaterializationResponse(
      record(
        data["materialization"],
        "verification materialized event identity",
      ),
    );
    if (
      materialization.authoritativeSourceBundleDigest !==
      identity.sourceBundleDigest
    ) {
      throw new Error(
        "verification materialized event/source bundle digest mismatch",
      );
    }
  }
  return value as VerificationEvent;
}

export function verificationEventIdentity(
  event: VerificationEvent,
): VerificationRunIdentity {
  return parseVerificationRunIdentity(
    event.identity,
    "verification event identity",
  );
}

export function parseVerificationEvidenceResponse(
  value: unknown,
): VerificationEvidenceEnvelope {
  const envelope = record(value, "verification Evidence envelope");
  assertTenant(envelope, "verification Evidence envelope");
  const identity = parseVerificationRunIdentity(
    envelope["identity"],
    "verification Evidence envelope identity",
  );
  assertTopLevelRunIdentity(
    envelope,
    identity,
    "verification Evidence envelope",
  );
  const ref = parseEvidenceReference(envelope["ref"]);
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
  if (ref !== evidenceReference(evidence)) {
    throw new Error("verification Evidence response ref/id mismatch");
  }
  const binding = verificationEvidenceBinding(evidence);
  assertVerificationRunIdentity(
    binding.identity,
    identity,
    "verification Evidence content identity",
  );
  const envelopeMaterialization = optionalRecord(
    envelope,
    "materialization",
    parseVerificationMaterializationResponse,
  );
  if (!sameMaterialization(envelopeMaterialization, binding.materialization)) {
    throw new Error("verification Evidence materialization identity mismatch");
  }
  if (binding.checkRef === undefined) {
    if (envelope["checkRef"] !== undefined) {
      throw new Error("verification verdict Evidence cannot claim a checkRef");
    }
  } else if (envelope["checkRef"] !== binding.checkRef) {
    throw new Error("verification check Evidence identity mismatch");
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

export function parseVerificationMaterializationResponse(
  value: Record<string, unknown>,
): VerificationMaterialization {
  const keys = Object.keys(value);
  const expected = new Set([
    "schemaVersion",
    "ref",
    "runtimeDescriptorDigest",
    "authoritativeSourceBundleDigest",
    "entryCount",
    "totalBytes",
  ]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(
      "verification materialization contains missing or unsupported fields",
    );
  }
  if (value["schemaVersion"] !== "octopus.reef.materialization/v1") {
    throw new Error("unsupported verification materialization version");
  }
  if (
    typeof value["ref"] !== "string" ||
    !/^materialization:[0-9a-f]{64}$/.test(value["ref"])
  ) {
    throw new Error("verification materialization ref is not canonical");
  }
  const runtimeDescriptorDigest = digest(value, "runtimeDescriptorDigest");
  if (
    value["ref"] !==
    `materialization:${runtimeDescriptorDigest.slice("sha256:".length)}`
  ) {
    throw new Error(
      "verification materialization ref/descriptor digest mismatch",
    );
  }
  digest(value, "authoritativeSourceBundleDigest");
  positiveInteger(value, "entryCount");
  nonnegativeInteger(value, "totalBytes");
  return value as unknown as VerificationMaterialization;
}

export function parseVerificationCheckResultResponse(
  value: unknown,
): VerificationCheckResult {
  const result = record(value, "verification check result");
  parseVerificationRunIdentity(
    result["identity"],
    "verification check result identity",
  );
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
  parseEvidenceReference(result["evidenceRef"]);
  digest(result, "evidenceDigest");
  return value as VerificationCheckResult;
}

function parseArtifact(value: unknown): VerificationArtifact {
  const artifact = record(value, "verification artifact");
  parseArtifactReference(artifact["ref"]);
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
  parseVerificationRunIdentity(
    value["identity"],
    "verification verdict identity",
  );
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
  parseEvidenceReference(value["evidenceRef"]);
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

function assertTopLevelRunIdentity(
  value: Record<string, unknown>,
  identity: VerificationRunIdentity,
  name: string,
): void {
  if (
    value["organisationRef"] !== identity.organisationRef ||
    value["projectRef"] !== identity.projectRef
  ) {
    throw new Error(`${name} top-level identity mismatch`);
  }
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
  return parseVerificationDecimalCursor(value[key], key);
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

function sameMaterialization(
  left: VerificationMaterialization | undefined,
  right: VerificationMaterialization | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.ref === right.ref &&
    left.runtimeDescriptorDigest === right.runtimeDescriptorDigest &&
    left.authoritativeSourceBundleDigest ===
      right.authoritativeSourceBundleDigest &&
    left.entryCount === right.entryCount &&
    left.totalBytes === right.totalBytes
  );
}

const IDENTITY_KEYS = VERIFICATION_IDENTITY_KEYS;
