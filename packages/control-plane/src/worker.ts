import { randomUUID } from "node:crypto";
import { setInterval as startInterval, clearInterval } from "node:timers";
import { DefaultBudgetController, emptyUsage } from "./budget.js";
import type {
  AcceptanceVerifier,
  AgentRunRepository,
  ArtifactStore,
  BudgetController,
  GitWorkspace,
  HumanReviewGateway,
  RunCheckpointStore,
  RunEventStore,
  RunQueue,
  SandboxProvisioner,
  SecretResolver,
} from "./ports.js";
import { isTerminal } from "./state-machine.js";
import type {
  AgentKernel,
  AgentRun,
  KernelCheckpoint,
  QueueLease,
  RunCheckpoint,
  RunFailure,
  RunMutation,
  SandboxHandle,
  TenantScope,
} from "./types.js";

export interface ControlPlaneWorkerOptions {
  readonly workerId: string;
  readonly runs: AgentRunRepository;
  readonly events: RunEventStore;
  readonly checkpoints: RunCheckpointStore;
  readonly queue: RunQueue;
  readonly sandboxes: SandboxProvisioner;
  readonly secrets: SecretResolver;
  readonly reviews: HumanReviewGateway;
  readonly budgets?: BudgetController;
  readonly acceptance: AcceptanceVerifier;
  readonly kernel: AgentKernel;
  readonly artifacts?: ArtifactStore;
  readonly git?: GitWorkspace;
  readonly leaseMs?: number;
  readonly maxInfrastructureRetries?: number;
  readonly retryBaseMs?: number;
  readonly now?: () => string;
  /** Test/observability hook; awaited after the checkpoint is durable. */
  readonly afterCheckpoint?: (
    checkpoint: RunCheckpoint,
    run: AgentRun,
  ) => Promise<void> | void;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly exceeded: string,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** Simulates SIGKILL in acceptance tests: no ack, retry, failure, or cleanup. */
export class WorkerProcessCrash extends Error {
  constructor(message = "worker process crashed") {
    super(message);
    this.name = "WorkerProcessCrash";
  }
}

/**
 * One horizontally scalable worker. Queue delivery is at-least-once; durable
 * checkpoint/step idempotency plus repository fencing make effects exactly-once
 * at a completed tool-result boundary.
 */
export class ControlPlaneWorker {
  readonly #options: ControlPlaneWorkerOptions;
  readonly #leaseMs: number;
  readonly #now: () => string;

  constructor(options: ControlPlaneWorkerOptions) {
    this.#options = options;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** Claim and process at most one delivery. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const queueLease = await this.#options.queue.claim({
      workerId: this.#options.workerId,
      leaseMs: this.#leaseMs,
      now: this.#now(),
    });
    if (queueLease === undefined) return false;
    await this.#process(queueLease);
    return true;
  }

  async #process(queueLease: QueueLease): Promise<void> {
    const scope: TenantScope = queueLease.message;
    const runId = queueLease.message.runId;
    let run = await this.#options.runs.acquireLease(scope, runId, {
      ownerId: this.#options.workerId,
      leaseMs: this.#leaseMs,
      now: this.#now(),
    });
    if (run === undefined) {
      // A duplicate SQS delivery can race the real owner. Removing this delivery
      // is safe because the repository, not the message, is the source of truth.
      await this.#options.queue.ack(queueLease);
      return;
    }
    const fence = run.lease!.fencingToken;
    const abort = new AbortController();
    let leaseLost = false;
    let processCrashed = false;
    let sandbox: SandboxHandle | undefined;
    const heartbeat = startInterval(
      () => {
        void this.#heartbeat(scope, runId, queueLease, fence).then((ok) => {
          if (!ok) {
            leaseLost = true;
            abort.abort("lease lost or run paused/cancelled");
          }
        });
      },
      Math.max(250, Math.floor(this.#leaseMs / 3)),
    );
    heartbeat.unref();

    try {
      run = await this.#enterProvisioning(scope, run, fence);
      const sandboxSpec = {
        ...scope,
        runId,
        projectRef: run.projectRef,
        baselineRevisionRef: run.baselineRevisionRef,
        attempt: run.attempt,
        environment: { AWS_EC2_METADATA_DISABLED: "true" },
      } as const;
      sandbox =
        (run.sandboxId !== undefined
          ? await this.#options.sandboxes.restore?.(sandboxSpec, run.sandboxId)
          : undefined) ??
        (await this.#options.sandboxes.provision(sandboxSpec));
      run = await this.#mutateFenced(scope, runId, fence, {
        sandboxId: sandbox.id,
      });
      await this.#options.git?.prepare(
        scope,
        runId,
        run.projectRef,
        run.baselineRevisionRef,
        sandbox.workspacePath,
      );
      run = await this.#enterRunning(scope, run, fence);
      const resolvedSecrets = await this.#options.secrets.resolve(
        scope,
        run.secretRefs,
      );
      const latestCheckpoint = await this.#options.checkpoints.latest(
        scope,
        runId,
      );
      const resumeFrom = latestCheckpoint?.idempotencyKey.startsWith(
        `attempt:${run.attempt}:`,
      )
        ? latestCheckpoint
        : undefined;
      if (resumeFrom !== undefined) {
        run = await this.#reconcileCheckpoint(scope, runId, fence, resumeFrom);
      }
      let budgetExceeded: BudgetExceededError | undefined;
      const acceptedResume = completedFromAcceptanceCheckpoint(resumeFrom);
      const result =
        acceptedResume ??
        (await this.#options.kernel.run({
          run,
          sandbox,
          secrets: resolvedSecrets,
          ...(resumeFrom !== undefined ? { resumeFrom } : {}),
          signal: abort.signal,
          checkpoint: async (checkpoint): Promise<void> => {
            try {
              run = await this.#persistCheckpoint(
                scope,
                runId,
                fence,
                checkpoint,
              );
            } catch (error) {
              if (error instanceof BudgetExceededError) budgetExceeded = error;
              abort.abort(error);
              throw error;
            }
          },
        }));

      if (budgetExceeded !== undefined) {
        await this.#options.queue.ack(queueLease);
        return;
      }
      const current = await this.#options.runs.get(scope, runId);
      if (current === undefined) throw new Error("run disappeared");
      if (
        current.status === "CANCELLED" ||
        current.status === "WAITING_FOR_REVIEW"
      ) {
        await this.#options.queue.ack(queueLease);
        return;
      }
      if (leaseLost) throw new Error("run lease lost");

      if (result.outcome === "WAITING_FOR_REVIEW") {
        const reviewId = randomUUID();
        const now = this.#now();
        await this.#options.reviews.request({
          ...scope,
          id: reviewId,
          runId,
          reason: result.reason,
          ...(result.context !== undefined ? { context: result.context } : {}),
          createdAt: now,
        });
        run = await this.#mutateFenced(scope, runId, fence, {
          status: "WAITING_FOR_REVIEW",
          reviewId,
          clearLease: true,
        });
        await this.#options.events.append(
          scope,
          runId,
          "run.waiting_for_review",
          { reviewId, reason: result.reason },
          now,
          `review-request:${reviewId}`,
        );
        await this.#options.queue.ack(queueLease);
        return;
      }

      if (result.outcome === "FAILED") {
        await this.#finishFailed(scope, runId, fence, result.failure);
        await this.#options.queue.ack(queueLease);
        return;
      }

      if (acceptedResume === undefined) {
        run = await this.#transition(scope, runId, fence, "VERIFYING");
        const acceptance = await this.#options.acceptance.verify(
          run,
          result.proof,
        );
        await this.#persistCheckpoint(scope, runId, fence, {
          kind: "VERIFICATION",
          idempotencyKey: `verification:${run.attempt}`,
          payload: {
            controlPlaneAcceptance: true,
            acceptance,
            output: result.output,
            proof: result.proof,
            resultRefs: result.resultRefs,
          },
          usage: { outputBytes: Buffer.byteLength(result.output, "utf8") },
        });
        if (!acceptance.accepted) {
          await this.#finishFailed(scope, runId, fence, {
            code: "ACCEPTANCE_FAILED",
            message: acceptance.reason,
            retryable: true,
          });
          await this.#options.queue.ack(queueLease);
          return;
        }
      } else if (run.status === "RUNNING") {
        run = await this.#transition(scope, runId, fence, "VERIFYING");
      }
      let diffRef = result.resultRefs?.diffRef;
      const testRef = result.resultRefs?.testRef;
      const evidenceRefs = new Set(result.resultRefs?.evidenceRefs ?? []);
      if (this.#options.git !== undefined) {
        const committed = await this.#options.git.commit(
          scope,
          runId,
          run.baselineRevisionRef,
          sandbox.workspacePath,
          `reef: complete AgentRun ${runId}`,
        );
        diffRef ??= committed.diffRef;
        await this.#options.events.append(
          scope,
          runId,
          "workspace.committed",
          committed,
          this.#now(),
          `workspace-commit:${run.attempt}`,
        );
      }
      if (this.#options.artifacts !== undefined) {
        const artifact = await this.#options.artifacts.put(
          scope,
          runId,
          `proof/attempt-${run.attempt}.json`,
          Buffer.from(JSON.stringify(result.proof ?? {}), "utf8"),
          "application/json",
        );
        evidenceRefs.add(artifact.uri);
        await this.#options.events.append(
          scope,
          runId,
          "artifact.stored",
          artifact,
          this.#now(),
          `proof-artifact:${run.attempt}`,
        );
      }
      const resultRefs = {
        ...(diffRef !== undefined ? { diffRef } : {}),
        ...(testRef !== undefined ? { testRef } : {}),
        evidenceRefs: [...evidenceRefs],
      };
      const now = this.#now();
      run = await this.#mutateFenced(scope, runId, fence, {
        status: "COMPLETED",
        output: result.output,
        resultRefs,
        finishedAt: now,
        clearLease: true,
      });
      await this.#options.events.append(
        scope,
        runId,
        "run.completed",
        { output: result.output, resultRefs, usage: run.usage },
        now,
        `completed:${run.attempt}`,
      );
      await this.#options.queue.ack(queueLease);
    } catch (error) {
      if (error instanceof WorkerProcessCrash) {
        processCrashed = true;
        throw error;
      }
      const latest = await this.#options.runs.get(scope, runId);
      if (latest !== undefined && isTerminal(latest.status)) {
        await this.#options.queue.ack(queueLease);
        return;
      }
      if (latest?.status === "WAITING_FOR_REVIEW") {
        await this.#options.queue.ack(queueLease);
        return;
      }
      if (error instanceof BudgetExceededError) {
        await this.#options.queue.ack(queueLease);
        return;
      }
      const attempts = queueLease.message.attempt + 1;
      const max = this.#options.maxInfrastructureRetries ?? 5;
      if (attempts <= max && !leaseLost) {
        await this.#releaseLease(scope, runId, fence);
        await this.#options.queue.retry(
          queueLease,
          new Date(
            Date.parse(this.#now()) + this.#backoff(attempts),
          ).toISOString(),
        );
        await this.#options.events.append(
          scope,
          runId,
          "run.retry_scheduled",
          { attempt: attempts, error: errorText(error) },
          this.#now(),
          `infrastructure-retry:${attempts}`,
        );
        return;
      }
      if (!leaseLost) {
        await this.#finishFailed(scope, runId, fence, {
          code: "INFRASTRUCTURE_ERROR",
          message: errorText(error),
          retryable: true,
        });
      }
      await this.#options.queue.ack(queueLease);
    } finally {
      clearInterval(heartbeat);
      if (sandbox !== undefined && !leaseLost && !processCrashed) {
        await this.#options.sandboxes.destroy(sandbox).catch(() => undefined);
      }
    }
  }

  async #enterProvisioning(
    scope: TenantScope,
    initial: AgentRun,
    fence: number,
  ): Promise<AgentRun> {
    let run = initial;
    if (run.status === "QUEUED") {
      run = await this.#transition(scope, run.id, fence, "PROVISIONING", {
        ...(run.startedAt === undefined ? { startedAt: this.#now() } : {}),
      });
    }
    return run;
  }

  async #enterRunning(
    scope: TenantScope,
    initial: AgentRun,
    fence: number,
  ): Promise<AgentRun> {
    let run = initial;
    if (run.status === "PROVISIONING") {
      run = await this.#transition(scope, run.id, fence, "PLANNING");
    }
    if (run.status === "PLANNING") {
      run = await this.#transition(scope, run.id, fence, "RUNNING");
    } else if (
      run.status === "WAITING_FOR_TOOL" ||
      run.status === "VERIFYING"
    ) {
      run = await this.#transition(scope, run.id, fence, "RUNNING");
    }
    if (run.status !== "RUNNING") {
      throw new Error(`worker cannot execute run in ${run.status}`);
    }
    return run;
  }

  async #persistCheckpoint(
    scope: TenantScope,
    runId: string,
    fence: number,
    input: KernelCheckpoint,
  ): Promise<AgentRun> {
    const now = this.#now();
    let run = await this.#requiredRun(scope, runId);
    const durableIdempotencyKey = `attempt:${run.attempt}:${input.idempotencyKey}`;
    const stored = await this.#options.checkpoints.save(scope, runId, {
      idempotencyKey: durableIdempotencyKey,
      kind: input.kind,
      payload: input.payload,
      ...(input.step !== undefined ? { step: input.step } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      fencingToken: fence,
      createdAt: now,
    });
    run = await this.#requiredRun(scope, runId);
    if (!stored.created) {
      return this.#applyCheckpointUsage(scope, runId, fence, now);
    }

    if (input.kind === "TOOL_INTENT") {
      if (run.status === "RUNNING") {
        run = await this.#transition(scope, runId, fence, "WAITING_FOR_TOOL");
      }
      if (input.step !== undefined) {
        const steps = await this.#options.runs.listSteps(scope, runId);
        await this.#options.runs.createStep({
          ...scope,
          id: input.step.id,
          runId,
          ordinal: steps.length + 1,
          kind: input.step.kind,
          idempotencyKey: durableIdempotencyKey,
          status: "WAITING_FOR_TOOL",
          attempt: run.attempt,
          fencingToken: fence,
          ...(input.step.input !== undefined
            ? { input: input.step.input }
            : {}),
          createdAt: now,
          updatedAt: now,
        });
      }
    } else if (input.kind === "TOOL_RESULT") {
      if (input.step !== undefined) {
        const intentKey = durableIdempotencyKey.replace(
          "tool-result:",
          "tool-intent:",
        );
        const step = await this.#options.runs.getStepByIdempotencyKey(
          scope,
          runId,
          intentKey,
        );
        if (step !== undefined) {
          await this.#options.runs.completeStep(
            scope,
            runId,
            step.id,
            fence,
            input.step.output,
            now,
          );
        }
      }
      if (run.status === "WAITING_FOR_TOOL") {
        run = await this.#transition(scope, runId, fence, "RUNNING");
      }
    } else if (input.kind === "VERIFICATION" && run.status === "RUNNING") {
      run = await this.#transition(scope, runId, fence, "VERIFYING");
    }

    run = await this.#applyCheckpointUsage(scope, runId, fence, now);
    await this.#options.events.append(
      scope,
      runId,
      `checkpoint.${input.kind.toLowerCase()}`,
      {
        checkpointId: stored.checkpoint.id,
        sequence: stored.checkpoint.sequence,
        idempotencyKey: durableIdempotencyKey,
      },
      now,
      `checkpoint-event:${durableIdempotencyKey}`,
    );
    await this.#options.afterCheckpoint?.(stored.checkpoint, run);
    return run;
  }

  async #transition(
    scope: TenantScope,
    runId: string,
    fence: number,
    status: AgentRun["status"],
    extra: RunMutation = {},
  ): Promise<AgentRun> {
    const run = await this.#mutateFenced(scope, runId, fence, {
      ...extra,
      status,
    });
    await this.#options.events.append(
      scope,
      runId,
      "run.status_changed",
      { status, version: run.version },
      this.#now(),
      `status:${run.version}:${status}`,
    );
    return run;
  }

  async #reconcileCheckpoint(
    scope: TenantScope,
    runId: string,
    fence: number,
    checkpoint: RunCheckpoint,
  ): Promise<AgentRun> {
    let run = await this.#applyCheckpointUsage(
      scope,
      runId,
      fence,
      this.#now(),
    );
    if (checkpoint.kind === "TOOL_RESULT" && checkpoint.step !== undefined) {
      const intentKey = checkpoint.idempotencyKey.replace(
        "tool-result:",
        "tool-intent:",
      );
      const step = await this.#options.runs.getStepByIdempotencyKey(
        scope,
        runId,
        intentKey,
      );
      if (step !== undefined && step.status !== "COMPLETED") {
        await this.#options.runs.completeStep(
          scope,
          runId,
          step.id,
          fence,
          checkpoint.step.output,
          this.#now(),
        );
      }
      if (run.status === "WAITING_FOR_TOOL") {
        run = await this.#transition(scope, runId, fence, "RUNNING");
      }
    }
    return run;
  }

  async #applyCheckpointUsage(
    scope: TenantScope,
    runId: string,
    fence: number,
    now: string,
  ): Promise<AgentRun> {
    let run = await this.#requiredRun(scope, runId);
    const prefix = `attempt:${run.attempt}:`;
    const aggregate: {
      tokens: number;
      costUsd: number;
      wallTimeMs: number;
      toolCalls: number;
      outputBytes: number;
    } = {
      tokens: 0,
      costUsd: 0,
      wallTimeMs: 0,
      toolCalls: 0,
      outputBytes: 0,
    };
    const checkpoints = await this.#options.checkpoints.listCheckpoints(
      scope,
      runId,
    );
    for (const checkpoint of checkpoints) {
      if (!checkpoint.idempotencyKey.startsWith(prefix)) continue;
      aggregate.tokens += checkpoint.usage?.tokens ?? 0;
      aggregate.costUsd += checkpoint.usage?.costUsd ?? 0;
      aggregate.wallTimeMs += checkpoint.usage?.wallTimeMs ?? 0;
      aggregate.toolCalls += checkpoint.usage?.toolCalls ?? 0;
      aggregate.outputBytes += checkpoint.usage?.outputBytes ?? 0;
    }
    const decision = (
      this.#options.budgets ?? new DefaultBudgetController()
    ).evaluate({ ...run, usage: emptyUsage() }, aggregate, now);
    if (!decision.allowed) {
      run = await this.#mutateFenced(scope, runId, fence, {
        status: "BUDGET_EXCEEDED",
        usage: decision.usage,
        failure: {
          code: "BUDGET_EXCEEDED",
          message: decision.reason ?? "run budget exceeded",
          retryable: true,
        },
        finishedAt: now,
        clearLease: true,
      });
      await this.#options.events.append(
        scope,
        runId,
        "run.budget_exceeded",
        { exceeded: decision.exceeded, usage: decision.usage },
        now,
        `budget:attempt:${run.attempt}`,
      );
      throw new BudgetExceededError(
        decision.exceeded ?? "unknown",
        decision.reason ?? "run budget exceeded",
      );
    }
    return this.#mutateFenced(scope, runId, fence, {
      usage: decision.usage,
    });
  }

  async #mutateFenced(
    scope: TenantScope,
    runId: string,
    fence: number,
    mutation: RunMutation,
  ): Promise<AgentRun> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.#requiredRun(scope, runId);
      if (current.lease?.fencingToken !== fence) {
        throw new Error(`stale fencing token ${fence} for run ${runId}`);
      }
      const next = await this.#options.runs.mutate(
        scope,
        runId,
        current.version,
        mutation,
        fence,
      );
      if (next !== undefined) return next;
    }
    throw new Error(`concurrent updates prevented fenced mutation of ${runId}`);
  }

  async #finishFailed(
    scope: TenantScope,
    runId: string,
    fence: number,
    failure: RunFailure,
  ): Promise<void> {
    const now = this.#now();
    await this.#mutateFenced(scope, runId, fence, {
      status: "FAILED",
      failure,
      finishedAt: now,
      clearLease: true,
    });
    await this.#options.events.append(
      scope,
      runId,
      "run.failed",
      failure,
      now,
      `failed:${failure.code}:${runId}`,
    );
  }

  async #releaseLease(
    scope: TenantScope,
    runId: string,
    fence: number,
  ): Promise<void> {
    await this.#mutateFenced(scope, runId, fence, { clearLease: true });
  }

  async #heartbeat(
    scope: TenantScope,
    runId: string,
    queueLease: QueueLease,
    fence: number,
  ): Promise<boolean> {
    const expiresAt = new Date(
      Date.parse(this.#now()) + this.#leaseMs,
    ).toISOString();
    const [queueOk, runOk] = await Promise.all([
      this.#options.queue.heartbeat(queueLease, expiresAt),
      this.#options.runs.heartbeatLease(
        scope,
        runId,
        this.#options.workerId,
        fence,
        expiresAt,
      ),
    ]);
    return queueOk && runOk;
  }

  #backoff(attempt: number): number {
    const base = this.#options.retryBaseMs ?? 1_000;
    return Math.min(60_000, base * 2 ** Math.max(0, attempt - 1));
  }

  async #requiredRun(scope: TenantScope, runId: string): Promise<AgentRun> {
    const run = await this.#options.runs.get(scope, runId);
    if (run === undefined) throw new Error(`run not found: ${runId}`);
    return run;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completedFromAcceptanceCheckpoint(
  checkpoint: RunCheckpoint | undefined,
):
  | {
      readonly outcome: "COMPLETED";
      readonly output: string;
      readonly proof?: unknown;
      readonly resultRefs?: Partial<import("./types.js").RunResultReferences>;
    }
  | undefined {
  const value = checkpoint?.payload;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const acceptance = record["acceptance"];
  if (
    record["controlPlaneAcceptance"] !== true ||
    acceptance === null ||
    typeof acceptance !== "object" ||
    (acceptance as Record<string, unknown>)["accepted"] !== true ||
    typeof record["output"] !== "string"
  ) {
    return undefined;
  }
  return {
    outcome: "COMPLETED",
    output: record["output"],
    ...(record["proof"] !== undefined ? { proof: record["proof"] } : {}),
    ...(record["resultRefs"] !== undefined
      ? {
          resultRefs: record["resultRefs"] as Partial<
            import("./types.js").RunResultReferences
          >,
        }
      : {}),
  };
}
