import { randomUUID } from "node:crypto";
import { emptyUsage } from "./budget.js";
import type {
  AgentRunRepository,
  HumanReviewGateway,
  RunEventStore,
  RunQueue,
} from "./ports.js";
import { isTerminal } from "./state-machine.js";
import type {
  AgentRun,
  CreateAgentRunRequest,
  ReviewDecision,
  RunEvent,
  RunMutation,
  TenantScope,
} from "./types.js";
import { validateCreateRunRequest, validateScope } from "./validation.js";

export interface ControlPlaneServiceOptions {
  readonly runs: AgentRunRepository;
  readonly events: RunEventStore;
  readonly queue: RunQueue;
  readonly reviews: HumanReviewGateway;
  readonly now?: () => string;
  readonly id?: () => string;
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`AgentRun not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

/** Command/query facade used by HTTP, CLI, Builder, or any other surface. */
export class ControlPlaneService {
  readonly #runs: AgentRunRepository;
  readonly #events: RunEventStore;
  readonly #queue: RunQueue;
  readonly #reviews: HumanReviewGateway;
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(options: ControlPlaneServiceOptions) {
    this.#runs = options.runs;
    this.#events = options.events;
    this.#queue = options.queue;
    this.#reviews = options.reviews;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? randomUUID;
  }

  async createRun(
    scope: TenantScope,
    request: CreateAgentRunRequest,
  ): Promise<AgentRun> {
    validateScope(scope);
    validateCreateRunRequest(request);
    const existing = await this.#runs.getByIdempotencyKey(
      scope,
      request.idempotencyKey,
    );
    if (existing !== undefined) return existing;
    const now = this.#now();
    const run: AgentRun = {
      ...scope,
      id: this.#id(),
      task: request.task,
      projectRef: request.projectRef,
      ...(request.workItemRef !== undefined
        ? { workItemRef: request.workItemRef }
        : {}),
      ...(request.acceptanceRef !== undefined
        ? { acceptanceRef: request.acceptanceRef }
        : {}),
      idempotencyKey: request.idempotencyKey,
      status: "QUEUED",
      version: 1,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      secretRefs: structuredClone(request.secretRefs ?? []),
      budget: structuredClone(request.budget ?? {}),
      usage: emptyUsage(),
      config: structuredClone(request.config ?? {}),
      metadata: structuredClone(request.metadata ?? {}),
    };
    const stored = await this.#runs.create(scope, run);
    if (!stored.created) return stored.run;
    await this.#events.append(
      scope,
      run.id,
      "run.queued",
      { status: "QUEUED", attempt: 0 },
      now,
      "run-created",
    );
    await this.#queue.enqueue(scope, run.id);
    return stored.run;
  }

  async getRun(scope: TenantScope, runId: string): Promise<AgentRun> {
    validateScope(scope);
    const run = await this.#runs.get(scope, runId);
    if (run === undefined) throw new RunNotFoundError(runId);
    return run;
  }

  async events(
    scope: TenantScope,
    runId: string,
    cursor = "0",
    limit = 100,
  ): Promise<readonly RunEvent[]> {
    await this.getRun(scope, runId);
    if (!/^\d+$/.test(cursor)) throw new Error("event cursor must be decimal");
    return this.#events.listEvents(scope, runId, cursor, limit);
  }

  async pause(
    scope: TenantScope,
    runId: string,
    reason = "paused by operator",
    actorRef = "operator",
  ): Promise<AgentRun> {
    const current = await this.getRun(scope, runId);
    if (isTerminal(current.status)) {
      throw new Error(`cannot pause terminal run in ${current.status}`);
    }
    if (current.status === "WAITING_FOR_REVIEW") return current;
    const now = this.#now();
    const reviewId = this.#id();
    await this.#reviews.request({
      ...scope,
      id: reviewId,
      runId,
      reason,
      context: { kind: "operator-pause", actorRef },
      createdAt: now,
    });
    const run = await this.#mutate(scope, runId, {
      status: "WAITING_FOR_REVIEW",
      reviewId,
      clearLease: true,
    });
    await this.#events.append(
      scope,
      runId,
      "run.waiting_for_review",
      { reviewId, reason, actorRef },
      now,
      `review-request:${reviewId}`,
    );
    return run;
  }

  async resume(scope: TenantScope, runId: string): Promise<AgentRun> {
    const current = await this.getRun(scope, runId);
    if (current.status !== "WAITING_FOR_REVIEW") {
      throw new Error(`run is not paused: ${current.status}`);
    }
    const run = await this.#mutate(scope, runId, {
      status: "QUEUED",
      clearLease: true,
      clearReview: true,
    });
    await this.#events.append(
      scope,
      runId,
      "run.resumed",
      { attempt: run.attempt },
      this.#now(),
      `resume:${run.version}`,
    );
    await this.#queue.enqueue(scope, runId, { attempt: run.attempt });
    return run;
  }

  async retry(scope: TenantScope, runId: string): Promise<AgentRun> {
    const current = await this.getRun(scope, runId);
    if (
      current.status !== "FAILED" &&
      current.status !== "CANCELLED" &&
      current.status !== "BUDGET_EXCEEDED"
    ) {
      throw new Error(`run cannot be retried from ${current.status}`);
    }
    const run = await this.#mutate(scope, runId, {
      status: "QUEUED",
      attempt: current.attempt + 1,
      usage: emptyUsage(),
      startedAt: this.#now(),
      clearLease: true,
      clearFailure: true,
      clearReview: true,
      clearFinishedAt: true,
      clearOutput: true,
      clearSandbox: true,
    });
    await this.#events.append(
      scope,
      runId,
      "run.retried",
      { attempt: run.attempt },
      this.#now(),
      `retry:${run.attempt}`,
    );
    await this.#queue.enqueue(scope, runId, { attempt: run.attempt });
    return run;
  }

  async cancel(
    scope: TenantScope,
    runId: string,
    reason = "cancelled by operator",
  ): Promise<AgentRun> {
    const current = await this.getRun(scope, runId);
    if (current.status === "CANCELLED") return current;
    if (isTerminal(current.status)) {
      throw new Error(`cannot cancel terminal run in ${current.status}`);
    }
    const now = this.#now();
    const run = await this.#mutate(scope, runId, {
      status: "CANCELLED",
      finishedAt: now,
      clearLease: true,
      failure: { code: "CANCELLED", message: reason, retryable: true },
    });
    await this.#events.append(
      scope,
      runId,
      "run.cancelled",
      { reason },
      now,
      `cancel:${run.version}`,
    );
    return run;
  }

  async approve(
    scope: TenantScope,
    runId: string,
    actorRef: string,
    reason?: string,
  ): Promise<AgentRun> {
    return this.#decide(scope, runId, "APPROVED", actorRef, reason);
  }

  async reject(
    scope: TenantScope,
    runId: string,
    actorRef: string,
    reason?: string,
  ): Promise<AgentRun> {
    return this.#decide(scope, runId, "REJECTED", actorRef, reason);
  }

  async #decide(
    scope: TenantScope,
    runId: string,
    decision: ReviewDecision["decision"],
    actorRef: string,
    reason?: string,
  ): Promise<AgentRun> {
    const current = await this.getRun(scope, runId);
    if (
      current.status !== "WAITING_FOR_REVIEW" ||
      current.reviewId === undefined
    ) {
      throw new Error(`run has no pending review: ${current.status}`);
    }
    const now = this.#now();
    await this.#reviews.decide(scope, {
      reviewId: current.reviewId,
      decision,
      actorRef,
      ...(reason !== undefined ? { reason } : {}),
      decidedAt: now,
    });
    await this.#events.append(
      scope,
      runId,
      `review.${decision.toLowerCase()}`,
      { reviewId: current.reviewId, actorRef, reason },
      now,
      `review-decision:${current.reviewId}`,
    );
    if (decision === "APPROVED") return this.resume(scope, runId);
    return this.cancel(scope, runId, reason ?? "review rejected");
  }

  async #mutate(
    scope: TenantScope,
    runId: string,
    mutation: RunMutation,
  ): Promise<AgentRun> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.getRun(scope, runId);
      const next = await this.#runs.mutate(
        scope,
        runId,
        current.version,
        mutation,
      );
      if (next !== undefined) return next;
    }
    throw new Error(`concurrent updates prevented mutation of run ${runId}`);
  }
}
