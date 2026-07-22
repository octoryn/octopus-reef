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
  VerificationTenant,
  VerificationVerdict,
} from "./types.js";

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
      identity: identity(run),
      runRef: run.runRef,
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
      identity: identity(run),
      runRef: run.runRef,
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
  const stored = await store.get(tenant, ref);
  if (stored === undefined) return undefined;
  if (!verifyEvidence(stored.evidence)) {
    throw new Error("stored verification Evidence failed integrity verification");
  }
  const digest = evidenceDigest(stored.evidence);
  if (digest !== stored.digest) {
    throw new Error("stored verification Evidence digest mismatch");
  }
  return {
    ...tenant,
    ref,
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

function subjects(run: VerificationRun): readonly { type: string; id: string }[] {
  return [
    { type: "organisation", id: run.organisationRef },
    { type: "project", id: run.projectRef },
    { type: "foundation-candidate", id: run.candidateRef },
    { type: "source-bundle", id: run.sourceBundleRef },
    { type: "verification-run", id: run.runRef },
  ];
}

function identity(run: VerificationRun): Record<string, string> {
  return {
    organisationRef: run.organisationRef,
    projectRef: run.projectRef,
    candidateRef: run.candidateRef,
    candidateDigest: run.candidateDigest,
    sourceBundleRef: run.sourceBundleRef,
    sourceBundleDigest: run.sourceBundleDigest,
    verificationProfileRef: run.verificationProfileRef,
    verificationProfileVersion: run.verificationProfileVersion,
    verificationProfileDigest: run.verificationProfileDigest,
  };
}

function json(value: unknown): JsonValue {
  return value as JsonValue;
}
