/** Durable control-plane value types. No deployment or Builder types live here. */
import type { ReefCursorEvent } from "@octopus-reef/protocol";

export const AGENT_RUN_STATUSES = [
  "QUEUED",
  "PROVISIONING",
  "PLANNING",
  "RUNNING",
  "WAITING_FOR_TOOL",
  "VERIFYING",
  "WAITING_FOR_REVIEW",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "BUDGET_EXCEEDED",
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export type AgentStepStatus = AgentRunStatus;
export type AgentRunState = AgentRunStatus;
export type AgentStepState = AgentStepStatus;
export const AGENT_STEP_STATUSES = AGENT_RUN_STATUSES;

export const TERMINAL_RUN_STATUSES = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "BUDGET_EXCEEDED",
] as const satisfies readonly AgentRunStatus[];

export interface TenantScope {
  readonly organisationId: string;
  readonly projectId: string;
}

/** Builder and other callers remain outside the package and pass opaque refs. */
export interface RunReferences {
  readonly projectRef: string;
  readonly workItemRef?: string;
  readonly acceptanceRef?: string;
}

export interface SecretReference {
  /** Stable logical name used by a provider/adapter, never the secret value. */
  readonly name: string;
  /** Vault/Secrets Manager/runtime-specific opaque locator. */
  readonly secretRef: string;
}

export interface RunBudget {
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxWallTimeMs?: number;
  readonly maxToolCalls?: number;
  readonly maxOutputBytes?: number;
}

export interface RunUsage {
  readonly tokens: number;
  readonly costUsd: number;
  readonly wallTimeMs: number;
  readonly toolCalls: number;
  readonly outputBytes: number;
}

export interface UsageDelta {
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly wallTimeMs?: number;
  readonly toolCalls?: number;
  readonly outputBytes?: number;
}

export interface CreateAgentRunRequest extends RunReferences {
  readonly task: string;
  /** Deduplicates client retries within an organisation/project. */
  readonly idempotencyKey: string;
  readonly secretRefs?: readonly SecretReference[];
  readonly budget?: RunBudget;
  /** Kernel/provider configuration. Plaintext credential-shaped keys are rejected. */
  readonly config?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RunLease {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
}

export interface AgentRun extends TenantScope, RunReferences {
  readonly id: string;
  readonly task: string;
  readonly idempotencyKey: string;
  readonly status: AgentRunStatus;
  readonly version: number;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly secretRefs: readonly SecretReference[];
  readonly budget: RunBudget;
  readonly usage: RunUsage;
  readonly config: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly lease?: RunLease;
  readonly sandboxId?: string;
  readonly output?: string;
  readonly failure?: RunFailure;
  readonly reviewId?: string;
}

export interface RunFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentStep extends TenantScope {
  readonly id: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly status: AgentStepStatus;
  readonly attempt: number;
  readonly fencingToken: number;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly failure?: RunFailure;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export type CheckpointKind =
  "MODEL_RESPONSE" | "TOOL_INTENT" | "TOOL_RESULT" | "VERIFICATION";

export interface RunCheckpoint extends TenantScope {
  readonly id: string;
  readonly runId: string;
  /** Unique semantic boundary, e.g. tool-result:<tool-use-id>. */
  readonly idempotencyKey: string;
  readonly sequence: number;
  readonly kind: CheckpointKind;
  readonly payload: unknown;
  readonly step?: CheckpointStep;
  readonly usage?: UsageDelta;
  readonly checksum: string;
  readonly fencingToken: number;
  readonly createdAt: string;
}

export interface CheckpointStep {
  readonly id: string;
  readonly kind: string;
  readonly input?: unknown;
  readonly output?: unknown;
}

export interface StoredCheckpoint {
  readonly checkpoint: RunCheckpoint;
  /** False means this semantic checkpoint was already durable. */
  readonly created: boolean;
}

export interface RunEvent extends TenantScope, ReefCursorEvent {
  readonly id: string;
  readonly runId: string;
}

export interface QueueMessage extends TenantScope {
  readonly id: string;
  readonly runId: string;
  readonly attempt: number;
  readonly availableAt: string;
}

export interface QueueLease {
  readonly message: QueueMessage;
  readonly receipt: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
}

export interface QueueClaimOptions {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly now: string;
}

export interface SandboxSpec extends TenantScope {
  readonly runId: string;
  readonly projectRef: string;
  readonly attempt: number;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface SandboxExecution {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface SandboxExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxHandle {
  readonly id: string;
  readonly workspacePath: string;
  execute(command: SandboxExecution): Promise<SandboxExecutionResult>;
}

export interface ArtifactRef extends TenantScope {
  readonly runId: string;
  readonly key: string;
  readonly uri: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ReviewRequest extends TenantScope {
  readonly id: string;
  readonly runId: string;
  readonly reason: string;
  readonly context?: unknown;
  readonly createdAt: string;
}

export interface ReviewDecision {
  readonly reviewId: string;
  readonly decision: "APPROVED" | "REJECTED";
  readonly actorRef: string;
  readonly reason?: string;
  readonly decidedAt: string;
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly usage: RunUsage;
  readonly exceeded?: keyof RunBudget;
  readonly reason?: string;
}

export interface AcceptanceResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly evidence?: unknown;
}

export interface KernelCheckpoint {
  readonly kind: CheckpointKind;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly usage?: UsageDelta;
  readonly step?: CheckpointStep;
}

export interface KernelContext {
  readonly run: AgentRun;
  readonly sandbox: SandboxHandle;
  readonly secrets: Readonly<Record<string, string>>;
  readonly resumeFrom?: RunCheckpoint;
  readonly signal: AbortSignal;
  checkpoint(checkpoint: KernelCheckpoint): Promise<void>;
}

export type KernelResult =
  | {
      readonly outcome: "COMPLETED";
      readonly output: string;
      readonly proof?: unknown;
    }
  | {
      readonly outcome: "FAILED";
      readonly failure: RunFailure;
      readonly proof?: unknown;
    }
  | {
      readonly outcome: "WAITING_FOR_REVIEW";
      readonly reason: string;
      readonly context?: unknown;
      readonly proof?: unknown;
    };

/** Adapter over @octopus-reef/agent + engine; the control plane never owns a loop. */
export interface AgentKernel {
  run(context: KernelContext): Promise<KernelResult>;
}

export interface LeaseOptions {
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly now: string;
}

export interface RunMutation {
  readonly status?: AgentRunStatus;
  readonly attempt?: number;
  readonly usage?: RunUsage;
  readonly sandboxId?: string;
  readonly output?: string;
  readonly failure?: RunFailure;
  readonly reviewId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly clearLease?: boolean;
  readonly clearFailure?: boolean;
  readonly clearReview?: boolean;
  readonly clearFinishedAt?: boolean;
  readonly clearOutput?: boolean;
  readonly clearSandbox?: boolean;
}
