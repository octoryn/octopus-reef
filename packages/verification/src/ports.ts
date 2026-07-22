import type { Evidence } from "octopus-evidence";
import type {
  SourceBundleDescriptor,
  TrustedVerificationProfile,
  VerificationArtifact,
  VerificationCheckpoint,
  VerificationCheckResult,
  VerificationEvent,
  VerificationMutation,
  VerificationQueueLease,
  VerificationRun,
  VerificationSandbox,
  VerificationSandboxSpec,
  VerificationTenant,
} from "./types.js";
import type { TrustedVerificationProfileRegistry } from "./profile.js";

export interface VerificationEventInput {
  readonly type: string;
  readonly data: unknown;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

export interface VerificationDispatchInput {
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly availableAt: string;
}

export interface VerificationOutboxRecord
  extends VerificationTenant, VerificationDispatchInput {
  readonly id: string;
  readonly runRef: string;
  readonly deliveryAttempts: number;
}

export interface VerificationStore {
  createAndDispatch(
    run: VerificationRun,
    event: VerificationEventInput,
    dispatch: VerificationDispatchInput,
  ): Promise<{ readonly run: VerificationRun; readonly created: boolean }>;
  get(
    tenant: VerificationTenant,
    runRef: string,
  ): Promise<VerificationRun | undefined>;
  getByIdempotencyKey(
    tenant: VerificationTenant,
    idempotencyKey: string,
  ): Promise<VerificationRun | undefined>;
  mutateWithEvent(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    mutation: VerificationMutation,
    event: VerificationEventInput,
    fencingToken?: number,
  ): Promise<VerificationRun | undefined>;
  mutateAndDispatch(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    mutation: VerificationMutation,
    event: VerificationEventInput,
    dispatch: VerificationDispatchInput,
  ): Promise<VerificationRun | undefined>;
  acquireLease(
    tenant: VerificationTenant,
    runRef: string,
    ownerId: string,
    leaseMs: number,
    now: string,
  ): Promise<VerificationRun | undefined>;
  heartbeatLease(
    tenant: VerificationTenant,
    runRef: string,
    ownerId: string,
    fencingToken: number,
    expiresAt: string,
  ): Promise<boolean>;
  assertFence(
    tenant: VerificationTenant,
    runRef: string,
    fencingToken: number,
  ): Promise<boolean>;
  saveCheckResult(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    attempt: number,
    result: VerificationCheckResult,
    fencingToken: number,
    event: VerificationEventInput,
  ): Promise<VerificationRun | undefined>;
  checkpoints(
    tenant: VerificationTenant,
    runRef: string,
  ): Promise<readonly VerificationCheckpoint[]>;
  events(
    tenant: VerificationTenant,
    runRef: string,
    afterCursor?: string,
    limit?: number,
  ): Promise<readonly VerificationEvent[]>;
  claimOutbox(
    ownerId: string,
    leaseMs: number,
    limit?: number,
  ): Promise<readonly VerificationOutboxRecord[]>;
  markOutboxPublished(id: string, ownerId: string): Promise<void>;
  retryOutbox(
    id: string,
    ownerId: string,
    availableAt: string,
    error: string,
  ): Promise<void>;
}

export interface VerificationQueue {
  enqueue(
    tenant: VerificationTenant,
    runRef: string,
    attempt: number,
    delayMs?: number,
  ): Promise<void>;
  claim(
    workerId: string,
    leaseMs: number,
    now: string,
  ): Promise<VerificationQueueLease | undefined>;
  heartbeat(lease: VerificationQueueLease, expiresAt: string): Promise<boolean>;
  ack(lease: VerificationQueueLease): Promise<void>;
  retry(lease: VerificationQueueLease, availableAt: string): Promise<void>;
}

export interface VerificationSandboxProvisioner {
  provision(
    spec: VerificationSandboxSpec,
    signal: AbortSignal,
  ): Promise<VerificationSandbox>;
  restore?(
    spec: VerificationSandboxSpec,
    sandboxRef: string,
    signal: AbortSignal,
  ): Promise<VerificationSandbox | undefined>;
  destroy(sandbox: VerificationSandbox): Promise<void>;
}

export interface SourceBundleStore {
  descriptor(
    tenant: VerificationTenant,
    sourceBundleRef: string,
  ): Promise<SourceBundleDescriptor>;
  content(tenant: VerificationTenant, contentRef: string): Promise<Uint8Array>;
}

export interface SourceBundleMaterializer {
  materialize(
    run: VerificationRun,
    sandbox: VerificationSandbox,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface VerificationArtifactStore {
  put(
    tenant: VerificationTenant,
    runRef: string,
    kind: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<VerificationArtifact>;
  get(tenant: VerificationTenant, ref: string): Promise<Uint8Array | undefined>;
}

export interface VerificationEvidenceStore {
  put(
    tenant: VerificationTenant,
    evidence: Evidence,
  ): Promise<{ readonly ref: string; readonly digest: string }>;
  get(
    tenant: VerificationTenant,
    ref: string,
  ): Promise<
    { readonly evidence: Evidence; readonly digest: string } | undefined
  >;
}

export interface VerificationSecretResolver {
  resolve(
    tenant: VerificationTenant,
    bindings: readonly {
      readonly name: string;
      readonly secretRef: string;
      readonly environmentName: string;
    }[],
  ): Promise<Readonly<Record<string, string>>>;
}

export {
  type TrustedVerificationProfileRegistry,
  type TrustedVerificationProfile,
};
