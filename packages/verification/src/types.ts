import type { Evidence } from "octopus-evidence";
import type { VerificationDecimalCursor } from "./cursor.js";

export const VERIFICATION_STATES = [
  "queued",
  "provisioning",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];
export type VerificationCheckOutcome = "passed" | "failed" | "skipped";
export type VerificationVerdictOutcome = "passed" | "failed";

export interface VerificationTenant {
  readonly organisationRef: string;
  readonly projectRef: string;
}

export interface VerificationIdentity extends VerificationTenant {
  readonly candidateRef: string;
  readonly candidateDigest: string;
  readonly sourceBundleRef: string;
  readonly sourceBundleDigest: string;
  readonly verificationProfileRef: string;
  readonly verificationProfileVersion: string;
  readonly verificationProfileDigest: string;
}

export interface VerificationRunRequest extends VerificationIdentity {
  readonly idempotencyKey: string;
}

export interface VerificationRunIdentity extends VerificationIdentity {
  readonly runRef: string;
}

export interface VerificationArtifact {
  readonly ref: string;
  readonly digest: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly size: number;
}

export interface VerificationToolIdentity {
  readonly name: string;
  readonly version: string;
  readonly imageDigest: string;
}

export interface VerificationCheckResult {
  readonly identity: VerificationRunIdentity;
  readonly checkRef: string;
  readonly required: boolean;
  readonly outcome: VerificationCheckOutcome;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode?: number;
  readonly resultCode: string;
  readonly tool: VerificationToolIdentity;
  readonly artifacts: readonly VerificationArtifact[];
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
}

export interface VerificationVerdict {
  readonly identity: VerificationRunIdentity;
  readonly outcome: VerificationVerdictOutcome;
  readonly requiredChecks: readonly string[];
  readonly passedRequiredChecks: readonly string[];
  readonly failedRequiredChecks: readonly string[];
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
}

export interface VerificationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface VerificationLease {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
}

export interface VerificationRun extends VerificationIdentity {
  readonly runRef: string;
  readonly idempotencyKey: string;
  readonly state: VerificationState;
  readonly version: number;
  /** Starts at one and increments only on explicit retry. */
  readonly attempt: number;
  /** Exact decimal cursor of the latest durable event. */
  readonly eventCursor: VerificationDecimalCursor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly checks: readonly VerificationCheckResult[];
  readonly verdict?: VerificationVerdict;
  readonly failure?: VerificationFailure;
  readonly lease?: VerificationLease;
  readonly sandboxRef?: string;
}

export interface VerificationEvent extends VerificationTenant {
  readonly identity: VerificationRunIdentity;
  readonly id: string;
  readonly runRef: string;
  readonly cursor: VerificationDecimalCursor;
  readonly type: string;
  readonly data: unknown;
  readonly createdAt: string;
}

export interface VerificationCheckpoint extends VerificationTenant {
  readonly id: string;
  readonly runRef: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly checkRef: string;
  readonly result: VerificationCheckResult;
  readonly fencingToken: number;
  readonly createdAt: string;
}

export interface VerificationQueueMessage extends VerificationTenant {
  readonly id: string;
  readonly runRef: string;
  readonly attempt: number;
  readonly availableAt: string;
}

export interface VerificationQueueLease {
  readonly message: VerificationQueueMessage;
  readonly receipt: string;
  readonly ownerId: string;
  readonly expiresAt: string;
}

export interface VerificationProfileSecretBinding {
  readonly name: string;
  readonly secretRef: string;
  readonly environmentName: string;
}

export interface VerificationCheckDefinition {
  readonly checkRef: string;
  readonly required: boolean;
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly secretBindings?: readonly VerificationProfileSecretBinding[];
  readonly tool: VerificationToolIdentity;
  readonly expectedArtifacts?: readonly {
    readonly path: string;
    readonly kind: string;
    readonly mediaType: string;
    readonly required: boolean;
    readonly maxBytes: number;
  }[];
}

export interface TrustedVerificationProfile {
  readonly ref: string;
  readonly version: string;
  readonly digest: string;
  readonly sandboxImageDigest: string;
  readonly maxDurationMs: number;
  readonly maxChecks: number;
  readonly checks: readonly VerificationCheckDefinition[];
}

export interface SourceBundleEntry {
  readonly path: string;
  readonly size: number;
  readonly digest: string;
  readonly contentRef: string;
}

export interface SourceBundleDescriptor extends VerificationTenant {
  readonly schemaVersion: "reef.source-bundle.v1";
  readonly sourceBundleRef: string;
  readonly sourceBundleDigest: string;
  readonly unicodeNormalization: "NFC";
  readonly entries: readonly SourceBundleEntry[];
}

export interface VerificationEvidenceEnvelope extends VerificationTenant {
  readonly identity: VerificationRunIdentity;
  readonly checkRef?: string;
  readonly ref: string;
  readonly digest: string;
  readonly evidence: Evidence;
  readonly verifier: {
    readonly implementation: "octopus-evidence";
    readonly version: "0.2.0";
    readonly integrityVerified: true;
  };
}

export interface VerificationCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
}

export interface VerificationSandboxSpec extends VerificationIdentity {
  readonly runRef: string;
  readonly attempt: number;
  readonly imageDigest: string;
}

export interface VerificationSandbox {
  readonly id: string;
  readonly workspacePath: string;
  writeFile(
    path: string,
    content: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
  execute(
    check: VerificationCheckDefinition,
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<VerificationCommandResult>;
  readFile(
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | undefined>;
}

export interface VerificationMutation {
  readonly state?: VerificationState;
  readonly attempt?: number;
  readonly eventCursor?: VerificationDecimalCursor;
  readonly checks?: readonly VerificationCheckResult[];
  readonly verdict?: VerificationVerdict;
  readonly failure?: VerificationFailure;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly sandboxRef?: string;
  readonly clearFailure?: boolean;
  readonly clearVerdict?: boolean;
  readonly clearLease?: boolean;
}
