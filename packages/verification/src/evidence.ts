import {
  canonicalHash,
  createEvidence,
  verifyEvidence,
  type Evidence,
  type JsonValue,
} from "octopus-evidence";
import type { VerificationEvidenceStore } from "./ports.js";
import type {
  TrustedVerificationProfile,
  VerificationCheckResult,
  VerificationEvidenceEnvelope,
  VerificationRun,
  VerificationRunIdentity,
  VerificationMaterialization,
  VerificationTenant,
  VerificationVerdict,
} from "./types.js";
import {
  assertVerificationRunIdentity,
  parseVerificationRunIdentity,
  verificationRunIdentity,
} from "./identity.js";
import { assertDigest } from "./validation.js";

const EVIDENCE_REFERENCE = /^evidence:ev_[0-9a-f]{64}$/;
const ARTIFACT_REFERENCE = /^artifact:[0-9a-f]{64}$/;

export function createCheckEvidence(
  run: VerificationRun,
  profile: TrustedVerificationProfile,
  result: Omit<VerificationCheckResult, "evidenceRef" | "evidenceDigest">,
): Evidence {
  return createEvidence({
    kind: "deterministic-verification-check",
    subject: subjects(run),
    actor: { type: "verification-profile", id: profile.ref },
    content: json({
      identity: verificationRunIdentity(run),
      runRef: run.runRef,
      materialization: run.materialization ?? null,
      runVersion: run.version,
      attempt: run.attempt,
      profile: {
        ref: profile.ref,
        version: profile.version,
        digest: profile.digest,
      },
      check: {
        checkRef: result.checkRef,
        required: result.required,
        outcome: result.outcome,
        resultCode: result.resultCode,
        exitCode: result.exitCode ?? null,
        durationMs: result.durationMs,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        tool: result.tool,
        artifacts: result.artifacts.map((artifact) => ({
          ref: artifact.ref,
          digest: artifact.digest,
          kind: artifact.kind,
          mediaType: artifact.mediaType,
          size: artifact.size,
        })),
      },
    }),
    provenance: {
      source: "octopus-reef-verification",
      method: "trusted-profile-check",
      at: result.finishedAt,
    },
  });
}

export function createVerdictEvidence(
  run: VerificationRun,
  profile: TrustedVerificationProfile,
  verdict: Omit<VerificationVerdict, "evidenceRef" | "evidenceDigest">,
  checkEvidence: readonly { readonly ref: string; readonly digest: string }[],
  at: string,
): Evidence {
  return createEvidence({
    kind: "deterministic-verification-verdict",
    subject: subjects(run),
    actor: { type: "verification-profile", id: profile.ref },
    content: json({
      identity: verificationRunIdentity(run),
      runRef: run.runRef,
      materialization: run.materialization ?? null,
      runVersion: run.version,
      attempt: run.attempt,
      profile: {
        ref: profile.ref,
        version: profile.version,
        digest: profile.digest,
      },
      verdict,
      checkEvidence,
    }),
    provenance: {
      source: "octopus-reef-verification",
      method: "required-check-verdict",
      at,
    },
  });
}

export async function resolveEvidenceEnvelope(
  store: VerificationEvidenceStore,
  tenant: VerificationTenant,
  ref: string,
): Promise<VerificationEvidenceEnvelope | undefined> {
  const requestedRef = parseEvidenceReference(ref);
  const stored = await store.get(tenant, ref);
  if (stored === undefined) return undefined;
  if (stored.ref !== requestedRef) {
    throw new Error(
      "stored verification Evidence requested/returned ref mismatch",
    );
  }
  if (!verifyEvidence(stored.evidence)) {
    throw new Error(
      "stored verification Evidence failed integrity verification",
    );
  }
  const digest = evidenceDigest(stored.evidence);
  if (digest !== stored.digest) {
    throw new Error("stored verification Evidence digest mismatch");
  }
  const canonicalRef = evidenceReference(stored.evidence);
  if (requestedRef !== canonicalRef || stored.ref !== canonicalRef) {
    throw new Error("stored verification Evidence ref/id mismatch");
  }
  const binding = verificationEvidenceBinding(stored.evidence);
  if (
    binding.identity.organisationRef !== tenant.organisationRef ||
    binding.identity.projectRef !== tenant.projectRef
  ) {
    throw new Error("stored verification Evidence tenant identity mismatch");
  }
  return {
    ...tenant,
    identity: binding.identity,
    ...(binding.materialization === undefined
      ? {}
      : { materialization: binding.materialization }),
    ...(binding.checkRef === undefined ? {} : { checkRef: binding.checkRef }),
    ref: canonicalRef,
    digest,
    evidence: stored.evidence,
    verifier: {
      implementation: "octopus-evidence",
      version: "0.2.0",
      integrityVerified: true,
    },
  };
}

export function evidenceDigest(evidence: Evidence): string {
  return `sha256:${canonicalHash(evidence as never)}`;
}

export function evidenceReference(evidence: Evidence): string {
  if (!/^ev_[0-9a-f]{64}$/.test(evidence.id)) {
    throw new Error("verification Evidence id is not canonical");
  }
  return `evidence:${evidence.id}`;
}

export function parseEvidenceReference(value: unknown): string {
  if (typeof value !== "string" || !EVIDENCE_REFERENCE.test(value)) {
    throw new Error("verification Evidence ref is not canonical");
  }
  return value;
}

export function parseArtifactReference(value: unknown): string {
  if (typeof value !== "string" || !ARTIFACT_REFERENCE.test(value)) {
    throw new Error("verification artifact ref is not canonical");
  }
  return value;
}

export async function putVerifiedEvidence(
  store: VerificationEvidenceStore,
  tenant: VerificationTenant,
  evidence: Evidence,
): Promise<{ readonly ref: string; readonly digest: string }> {
  if (!verifyEvidence(evidence)) {
    throw new Error("refusing invalid verification Evidence");
  }
  const binding = verificationEvidenceBinding(evidence);
  if (
    binding.identity.organisationRef !== tenant.organisationRef ||
    binding.identity.projectRef !== tenant.projectRef
  ) {
    throw new Error("verification Evidence tenant identity mismatch");
  }
  const expected = {
    ref: evidenceReference(evidence),
    digest: evidenceDigest(evidence),
  };
  const stored = await store.put(tenant, evidence);
  if (stored.ref !== expected.ref || stored.digest !== expected.digest) {
    throw new Error("verification Evidence store put identity mismatch");
  }
  return expected;
}

export function verificationEvidenceBinding(evidence: Evidence): {
  readonly identity: VerificationRunIdentity;
  readonly checkRef?: string;
  readonly materialization?: VerificationMaterialization;
} {
  const content = object(evidence.content, "verification Evidence content");
  const runRef = text(content["runRef"], "verification Evidence runRef");
  const rawIdentity = object(
    content["identity"],
    "verification Evidence identity",
  );
  if (rawIdentity["runRef"] !== undefined && rawIdentity["runRef"] !== runRef) {
    throw new Error("verification Evidence run identity mismatch");
  }
  const identity = parseVerificationRunIdentity(
    { ...rawIdentity, runRef },
    "verification Evidence identity",
  );
  const materialization = parseEvidenceMaterialization(
    content["materialization"],
    identity.sourceBundleDigest,
  );
  const profile = object(
    content["profile"],
    "verification Evidence profile identity",
  );
  if (
    profile["ref"] !== identity.verificationProfileRef ||
    profile["version"] !== identity.verificationProfileVersion ||
    profile["digest"] !== identity.verificationProfileDigest
  ) {
    throw new Error("verification Evidence profile identity mismatch");
  }
  assertDigest(identity.candidateDigest, "verification candidate digest");
  assertDigest(identity.sourceBundleDigest, "verification source digest");
  assertDigest(
    identity.verificationProfileDigest,
    "verification profile digest",
  );
  assertEvidenceSubjects(evidence, identity);
  if (
    evidence.actor?.type !== "verification-profile" ||
    evidence.actor.id !== identity.verificationProfileRef
  ) {
    throw new Error("verification Evidence actor/profile mismatch");
  }

  if (evidence.kind === "deterministic-verification-check") {
    const check = object(content["check"], "verification check Evidence");
    const checkRef = text(
      check["checkRef"],
      "verification check Evidence checkRef",
    );
    const artifacts = check["artifacts"];
    if (!Array.isArray(artifacts)) {
      throw new Error("verification check Evidence artifacts must be an array");
    }
    for (const artifact of artifacts) {
      const record = object(artifact, "verification Evidence artifact");
      parseArtifactReference(record["ref"]);
      assertDigest(
        text(record["digest"], "verification Evidence artifact digest"),
      );
    }
    return {
      identity,
      ...(materialization === undefined ? {} : { materialization }),
      checkRef,
    };
  }
  if (evidence.kind === "deterministic-verification-verdict") {
    const verdict = object(
      content["verdict"],
      "verification verdict Evidence verdict",
    );
    const verdictIdentity = parseVerificationRunIdentity(
      verdict["identity"],
      "verification verdict Evidence identity",
    );
    assertVerificationRunIdentity(
      verdictIdentity,
      identity,
      "verification verdict Evidence identity",
    );
    const checkEvidence = content["checkEvidence"];
    if (!Array.isArray(checkEvidence)) {
      throw new Error("verification verdict Evidence links must be an array");
    }
    for (const link of checkEvidence) {
      const record = object(link, "verification verdict Evidence link");
      parseEvidenceReference(record["ref"]);
      assertDigest(
        text(record["digest"], "verification verdict Evidence digest"),
      );
    }
    return {
      identity,
      ...(materialization === undefined ? {} : { materialization }),
    };
  }
  throw new Error("unsupported verification Evidence kind");
}

function parseEvidenceMaterialization(
  value: unknown,
  sourceBundleDigest: string,
): VerificationMaterialization | undefined {
  if (value === null || value === undefined) return undefined;
  const record = object(value, "verification Evidence materialization");
  const expected = new Set([
    "schemaVersion",
    "ref",
    "runtimeDescriptorDigest",
    "authoritativeSourceBundleDigest",
    "entryCount",
    "totalBytes",
  ]);
  const keys = Object.keys(record);
  if (
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key)) ||
    record["schemaVersion"] !== "octopus.reef.materialization/v1" ||
    typeof record["ref"] !== "string" ||
    !/^materialization:[0-9a-f]{64}$/.test(record["ref"])
  ) {
    throw new Error("verification Evidence materialization is invalid");
  }
  const runtimeDescriptorDigest = text(
    record["runtimeDescriptorDigest"],
    "verification Evidence materialization descriptor digest",
  );
  const authoritativeSourceBundleDigest = text(
    record["authoritativeSourceBundleDigest"],
    "verification Evidence authoritative source bundle digest",
  );
  assertDigest(runtimeDescriptorDigest);
  assertDigest(authoritativeSourceBundleDigest);
  if (
    record["ref"] !==
    `materialization:${runtimeDescriptorDigest.slice("sha256:".length)}`
  ) {
    throw new Error(
      "verification Evidence materialization ref/digest mismatch",
    );
  }
  if (authoritativeSourceBundleDigest !== sourceBundleDigest) {
    throw new Error(
      "verification Evidence materialization/source digest mismatch",
    );
  }
  const entryCount = record["entryCount"];
  const totalBytes = record["totalBytes"];
  if (
    !Number.isSafeInteger(entryCount) ||
    Number(entryCount) < 1 ||
    !Number.isSafeInteger(totalBytes) ||
    Number(totalBytes) < 0
  ) {
    throw new Error("verification Evidence materialization counts are invalid");
  }
  return {
    schemaVersion: "octopus.reef.materialization/v1",
    ref: record["ref"],
    runtimeDescriptorDigest,
    authoritativeSourceBundleDigest,
    entryCount: Number(entryCount),
    totalBytes: Number(totalBytes),
  };
}

function subjects(
  run: VerificationRun,
): readonly { type: string; id: string }[] {
  return [
    { type: "organisation", id: run.organisationRef },
    { type: "project", id: run.projectRef },
    { type: "foundation-candidate", id: run.candidateRef },
    { type: "source-bundle", id: run.sourceBundleRef },
    { type: "verification-run", id: run.runRef },
  ];
}

function assertEvidenceSubjects(
  evidence: Evidence,
  identity: VerificationRunIdentity,
): void {
  const expected = [
    { type: "organisation", id: identity.organisationRef },
    { type: "project", id: identity.projectRef },
    { type: "foundation-candidate", id: identity.candidateRef },
    { type: "source-bundle", id: identity.sourceBundleRef },
    { type: "verification-run", id: identity.runRef },
  ];
  if (evidence.subject.length !== expected.length) {
    throw new Error("verification Evidence subjects are incomplete");
  }
  for (let index = 0; index < expected.length; index++) {
    const actual = evidence.subject[index]!;
    const wanted = expected[index]!;
    if (actual.type !== wanted.type || actual.id !== wanted.id) {
      throw new Error("verification Evidence subject identity mismatch");
    }
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function json(value: unknown): JsonValue {
  return value as JsonValue;
}
