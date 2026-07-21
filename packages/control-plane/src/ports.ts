import type {
  AcceptanceResult,
  AgentRun,
  AgentStep,
  ArtifactRef,
  BudgetDecision,
  CreateAgentRunRequest,
  LeaseOptions,
  QueueClaimOptions,
  QueueLease,
  ReviewDecision,
  ReviewRequest,
  RunCheckpoint,
  RunEvent,
  RunMutation,
  SandboxHandle,
  SandboxSpec,
  StoredCheckpoint,
  TenantScope,
  UsageDelta,
} from "./types.js";

export interface AgentRunRepository {
  create(
    scope: TenantScope,
    run: AgentRun,
  ): Promise<{ readonly run: AgentRun; readonly created: boolean }>;
  get(scope: TenantScope, runId: string): Promise<AgentRun | undefined>;
  getByIdempotencyKey(
    scope: TenantScope,
    idempotencyKey: string,
  ): Promise<AgentRun | undefined>;
  acquireLease(
    scope: TenantScope,
    runId: string,
    options: LeaseOptions,
  ): Promise<AgentRun | undefined>;
  heartbeatLease(
    scope: TenantScope,
    runId: string,
    ownerId: string,
    fencingToken: number,
    expiresAt: string,
  ): Promise<boolean>;
  mutate(
    scope: TenantScope,
    runId: string,
    expectedVersion: number,
    mutation: RunMutation,
    fencingToken?: number,
  ): Promise<AgentRun | undefined>;
  createStep(
    step: AgentStep,
  ): Promise<{ readonly step: AgentStep; readonly created: boolean }>;
  getStepByIdempotencyKey(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
  ): Promise<AgentStep | undefined>;
  completeStep(
    scope: TenantScope,
    runId: string,
    stepId: string,
    fencingToken: number,
    output: unknown,
    completedAt: string,
  ): Promise<AgentStep | undefined>;
  listSteps(scope: TenantScope, runId: string): Promise<readonly AgentStep[]>;
}

export interface RunEventStore {
  append(
    scope: TenantScope,
    runId: string,
    type: string,
    data: unknown,
    createdAt: string,
    idempotencyKey?: string,
  ): Promise<RunEvent>;
  listEvents(
    scope: TenantScope,
    runId: string,
    afterCursor?: string,
    limit?: number,
  ): Promise<readonly RunEvent[]>;
  getEventByIdempotencyKey(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
  ): Promise<RunEvent | undefined>;
}

export interface RunCheckpointStore {
  save(
    scope: TenantScope,
    runId: string,
    checkpoint: Omit<
      RunCheckpoint,
      "id" | "organisationId" | "projectId" | "runId" | "sequence" | "checksum"
    >,
  ): Promise<StoredCheckpoint>;
  latest(scope: TenantScope, runId: string): Promise<RunCheckpoint | undefined>;
  listCheckpoints(
    scope: TenantScope,
    runId: string,
  ): Promise<readonly RunCheckpoint[]>;
}

export interface RunQueue {
  enqueue(
    scope: TenantScope,
    runId: string,
    options?: { readonly delayMs?: number; readonly attempt?: number },
  ): Promise<void>;
  claim(options: QueueClaimOptions): Promise<QueueLease | undefined>;
  heartbeat(lease: QueueLease, expiresAt: string): Promise<boolean>;
  ack(lease: QueueLease): Promise<void>;
  retry(lease: QueueLease, availableAt: string): Promise<void>;
}

export interface SandboxProvisioner {
  provision(spec: SandboxSpec): Promise<SandboxHandle>;
  /** Reattach to a sandbox left behind by a process crash. */
  restore?(
    spec: SandboxSpec,
    sandboxId: string,
  ): Promise<SandboxHandle | undefined>;
  destroy(handle: SandboxHandle): Promise<void>;
}

export interface ArtifactStore {
  put(
    scope: TenantScope,
    runId: string,
    key: string,
    content: Uint8Array,
    contentType?: string,
  ): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
}

export interface GitWorkspace {
  prepare(
    scope: TenantScope,
    runId: string,
    projectRef: string,
    baselineRevisionRef: string,
    workspacePath: string,
  ): Promise<{ readonly branch: string; readonly worktreePath: string }>;
  commit(
    scope: TenantScope,
    runId: string,
    baselineRevisionRef: string,
    workspacePath: string,
    message: string,
  ): Promise<{ readonly commit: string; readonly diffRef: string }>;
  cleanup(
    scope: TenantScope,
    runId: string,
    workspacePath: string,
  ): Promise<void>;
}

export interface HumanReviewGateway {
  request(review: ReviewRequest): Promise<void>;
  decide(scope: TenantScope, decision: ReviewDecision): Promise<void>;
  get(
    scope: TenantScope,
    reviewId: string,
  ): Promise<
    | { readonly request: ReviewRequest; readonly decision?: ReviewDecision }
    | undefined
  >;
}

export interface SecretResolver {
  resolve(
    scope: TenantScope,
    refs: readonly { readonly name: string; readonly secretRef: string }[],
  ): Promise<Readonly<Record<string, string>>>;
}

export interface BudgetController {
  evaluate(run: AgentRun, delta: UsageDelta, now: string): BudgetDecision;
}

export interface AcceptanceVerifier {
  verify(run: AgentRun, proof: unknown): Promise<AcceptanceResult>;
}

export type RunRequestValidator = (request: CreateAgentRunRequest) => void;
