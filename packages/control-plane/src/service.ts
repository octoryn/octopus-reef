import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import {
  validateCreateRunRequest,
  validateIdempotencyKey,
  validateScope,
} from "./validation.js";

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

export class RunIdempotencyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(
      `idempotency key was reused with a different command: ${idempotencyKey}`,
    );
    this.name = "RunIdempotencyConflictError";
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
    if (existing !== undefined) {
      if (!sameCreateRequest(existing, request)) {
        throw new RunIdempotencyConflictError(request.idempotencyKey);
      }
      return existing;
    }
    const now = this.#now();
    const run: AgentRun = {
      ...scope,
      id: this.#id(),
      task: request.task,
      projectRef: request.projectRef,
      baselineRevisionRef: request.baselineRevisionRef,
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
      resultRefs: { evidenceRefs: [] },
    };
    const stored = await this.#runs.create(scope, run);
    if (!stored.created) {
      if (!sameCreateRequest(stored.run, request)) {
        throw new RunIdempotencyConflictError(request.idempotencyKey);
      }
      return stored.run;
    }
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
    idempotencyKey: string,
    reason = "paused by operator",
    actorRef = "operator",
  ): Promise<AgentRun> {
    validateIdempotencyKey(idempotencyKey);
    const current = await this.getRun(scope, runId);
    if (isTerminal(current.status)) {
      throw new Error(`cannot pause terminal run in ${current.status}`);
    }
    if (current.status === "WAITING_FOR_REVIEW") {
      const existing = await this.#events.getEventByIdempotencyKey(
        scope,
        runId,
        commandEventKey("pause", idempotencyKey),
      );
      if (existing !== undefined) {
        await this.#markCommand(scope, runId, "pause", idempotencyKey, {
          actorRef,
          reason,
          reviewId: commandString(existing.data, "reviewId"),
        });
      }
      return current;
    }
    const now = this.#now();
    const marker = await this.#markCommand(
      scope,
      runId,
      "pause",
      idempotencyKey,
      {
        actorRef,
        reason,
        reviewId: this.#id(),
      },
    );
    const reviewId = commandString(marker.data, "reviewId");
    await this.#reviews.request({
      ...scope,
      id: reviewId,
      runId,
      reason,
      context: { kind: "operator-pause", actorRef },
      createdAt: now,
    });
    let run: AgentRun;
    try {
      run = await this.#mutate(scope, runId, {
        status: "WAITING_FOR_REVIEW",
        reviewId,
        clearLease: true,
      });
    } catch (error) {
      const latest = await this.getRun(scope, runId);
      if (latest.status !== "WAITING_FOR_REVIEW") throw error;
      run = latest;
    }
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

  async resume(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
  ): Promise<AgentRun> {
    validateIdempotencyKey(idempotencyKey);
    const markerKey = commandEventKey("resume", idempotencyKey);
    const replay =
      (await this.#events.getEventByIdempotencyKey(scope, runId, markerKey)) !==
      undefined;
    const current = await this.getRun(scope, runId);
    if (current.status !== "WAITING_FOR_REVIEW") {
      if (replay) {
        if (current.status === "QUEUED") {
          await this.#queue.enqueue(scope, runId, { attempt: current.attempt });
        }
        return current;
      }
      throw new Error(`run is not paused: ${current.status}`);
    }
    await this.#markCommand(scope, runId, "resume", idempotencyKey, {});
    let run: AgentRun;
    try {
      run = await this.#mutate(scope, runId, {
        status: "QUEUED",
        clearLease: true,
        clearReview: true,
      });
    } catch (error) {
      const latest = await this.getRun(scope, runId);
      if (latest.status === "WAITING_FOR_REVIEW") throw error;
      run = latest;
    }
    await this.#events.append(
      scope,
      runId,
      "run.resumed",
      { attempt: run.attempt },
      this.#now(),
      `resume:${idempotencyKey}`,
    );
    await this.#queue.enqueue(scope, runId, { attempt: run.attempt });
    return run;
  }

  async retry(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
  ): Promise<AgentRun> {
    validateIdempotencyKey(idempotencyKey);
    const markerKey = commandEventKey("retry", idempotencyKey);
    const replay =
      (await this.#events.getEventByIdempotencyKey(scope, runId, markerKey)) !==
      undefined;
    const current = await this.getRun(scope, runId);
    if (
      current.status !== "FAILED" &&
      current.status !== "CANCELLED" &&
      current.status !== "BUDGET_EXCEEDED"
    ) {
      if (replay) {
        if (current.status === "QUEUED") {
          await this.#queue.enqueue(scope, runId, { attempt: current.attempt });
        }
        return current;
      }
      throw new Error(`run cannot be retried from ${current.status}`);
    }
    await this.#markCommand(scope, runId, "retry", idempotencyKey, {});
    let run: AgentRun;
    try {
      run = await this.#mutate(scope, runId, {
        status: "QUEUED",
        attempt: current.attempt + 1,
        usage: emptyUsage(),
        startedAt: this.#now(),
        clearLease: true,
        clearFailure: true,
        clearReview: true,
        clearFinishedAt: true,
        clearOutput: true,
        clearResultRefs: true,
        clearSandbox: true,
      });
    } catch (error) {
      const latest = await this.getRun(scope, runId);
      if (latest.status !== "QUEUED") throw error;
      run = latest;
    }
    await this.#events.append(
      scope,
      runId,
      "run.retried",
      { attempt: run.attempt },
      this.#now(),
      `retry:${idempotencyKey}`,
    );
    await this.#queue.enqueue(scope, runId, { attempt: run.attempt });
    return run;
  }

  async cancel(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
    reason = "cancelled by operator",
  ): Promise<AgentRun> {
    validateIdempotencyKey(idempotencyKey);
    const markerKey = commandEventKey("cancel", idempotencyKey);
    const replay =
      (await this.#events.getEventByIdempotencyKey(scope, runId, markerKey)) !==
      undefined;
    const current = await this.getRun(scope, runId);
    if (current.status === "CANCELLED") {
      if (replay) {
        await this.#markCommand(scope, runId, "cancel", idempotencyKey, {
          reason,
        });
      }
      return current;
    }
    if (replay && isTerminal(current.status)) return current;
    if (isTerminal(current.status)) {
      throw new Error(`cannot cancel terminal run in ${current.status}`);
    }
    await this.#markCommand(scope, runId, "cancel", idempotencyKey, { reason });
    const now = this.#now();
    let run: AgentRun;
    try {
      run = await this.#mutate(scope, runId, {
        status: "CANCELLED",
        finishedAt: now,
        clearLease: true,
        failure: { code: "CANCELLED", message: reason, retryable: true },
      });
    } catch (error) {
      const latest = await this.getRun(scope, runId);
      if (latest.status !== "CANCELLED") throw error;
      run = latest;
    }
    await this.#events.append(
      scope,
      runId,
      "run.cancelled",
      { reason },
      now,
      `cancel:${idempotencyKey}`,
    );
    return run;
  }

  async approve(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
    actorRef: string,
    reason?: string,
  ): Promise<AgentRun> {
    return this.#decide(
      scope,
      runId,
      "APPROVED",
      idempotencyKey,
      actorRef,
      reason,
    );
  }

  async reject(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
    actorRef: string,
    reason?: string,
  ): Promise<AgentRun> {
    return this.#decide(
      scope,
      runId,
      "REJECTED",
      idempotencyKey,
      actorRef,
      reason,
    );
  }

  async #decide(
    scope: TenantScope,
    runId: string,
    decision: ReviewDecision["decision"],
    idempotencyKey: string,
    actorRef: string,
    reason?: string,
  ): Promise<AgentRun> {
    validateIdempotencyKey(idempotencyKey);
    const action = decision === "APPROVED" ? "approve" : "reject";
    const markerKey = commandEventKey(action, idempotencyKey);
    const replay =
      (await this.#events.getEventByIdempotencyKey(scope, runId, markerKey)) !==
      undefined;
    const current = await this.getRun(scope, runId);
    if (
      current.status !== "WAITING_FOR_REVIEW" ||
      current.reviewId === undefined
    ) {
      if (replay) {
        await this.#markCommand(scope, runId, action, idempotencyKey, {
          actorRef,
          ...(reason !== undefined ? { reason } : {}),
        });
        return current;
      }
      throw new Error(`run has no pending review: ${current.status}`);
    }
    await this.#markCommand(scope, runId, action, idempotencyKey, {
      actorRef,
      ...(reason !== undefined ? { reason } : {}),
    });
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
      `review-decision:${decision.toLowerCase()}:${idempotencyKey}`,
    );
    if (decision === "APPROVED") {
      return this.resume(scope, runId, `approve:${idempotencyKey}`);
    }
    return this.cancel(
      scope,
      runId,
      `reject:${idempotencyKey}`,
      reason ?? "review rejected",
    );
  }

  async #markCommand(
    scope: TenantScope,
    runId: string,
    action: string,
    idempotencyKey: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<RunEvent> {
    const key = commandEventKey(action, idempotencyKey);
    const existing = await this.#events.getEventByIdempotencyKey(
      scope,
      runId,
      key,
    );
    if (existing !== undefined) {
      const existingCommand = commandData(existing.data);
      if (!isDeepStrictEqual(existingCommand, data)) {
        if (
          action !== "pause" ||
          !isDeepStrictEqual(
            withoutReviewId(existingCommand),
            withoutReviewId(data),
          )
        ) {
          throw new RunIdempotencyConflictError(idempotencyKey);
        }
      }
      return existing;
    }
    const event = await this.#events.append(
      scope,
      runId,
      "run.command_received",
      { action, idempotencyKey, ...data },
      this.#now(),
      key,
    );
    const stored = commandData(event.data);
    if (
      !isDeepStrictEqual(stored, data) &&
      (action !== "pause" ||
        !isDeepStrictEqual(withoutReviewId(stored), withoutReviewId(data)))
    ) {
      throw new RunIdempotencyConflictError(idempotencyKey);
    }
    return event;
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

function commandEventKey(action: string, idempotencyKey: string): string {
  return `command:${action}:${idempotencyKey}`;
}

function commandData(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored command event is invalid");
  }
  const data = { ...(value as Record<string, unknown>) };
  delete data.action;
  delete data.idempotencyKey;
  return data;
}

function commandString(value: unknown, field: string): string {
  const result = commandData(value)[field];
  if (typeof result !== "string" || result === "") {
    throw new Error(`stored command event has no ${field}`);
  }
  return result;
}

function withoutReviewId(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rest = { ...value };
  delete rest.reviewId;
  return rest;
}

function sameCreateRequest(
  existing: AgentRun,
  request: CreateAgentRunRequest,
): boolean {
  return isDeepStrictEqual(
    {
      task: existing.task,
      projectRef: existing.projectRef,
      baselineRevisionRef: existing.baselineRevisionRef,
      workItemRef: existing.workItemRef,
      acceptanceRef: existing.acceptanceRef,
      secretRefs: existing.secretRefs,
      budget: existing.budget,
      config: existing.config,
      metadata: existing.metadata,
    },
    {
      task: request.task,
      projectRef: request.projectRef,
      baselineRevisionRef: request.baselineRevisionRef,
      workItemRef: request.workItemRef,
      acceptanceRef: request.acceptanceRef,
      secretRefs: request.secretRefs ?? [],
      budget: request.budget ?? {},
      config: request.config ?? {},
      metadata: request.metadata ?? {},
    },
  );
}
