import { createHash, randomUUID } from "node:crypto";
import type {
  AgentRunRepository,
  HumanReviewGateway,
  RunCheckpointStore,
  RunEventStore,
  RunQueue,
} from "./ports.js";
import { assertRunTransition, isTerminal } from "./state-machine.js";
import type {
  AgentRun,
  AgentStep,
  LeaseOptions,
  QueueClaimOptions,
  QueueLease,
  QueueMessage,
  ReviewDecision,
  ReviewRequest,
  RunCheckpoint,
  RunEvent,
  RunMutation,
  StoredCheckpoint,
  TenantScope,
} from "./types.js";

const scoped = (scope: TenantScope, id: string): string =>
  `${scope.organisationId}\u0000${scope.projectId}\u0000${id}`;
const runScoped = (scope: TenantScope, runId: string, id: string): string =>
  `${scoped(scope, runId)}\u0000${id}`;

export class InMemoryControlPlaneStore
  implements AgentRunRepository, RunEventStore, RunCheckpointStore
{
  readonly #runs = new Map<string, AgentRun>();
  readonly #idempotency = new Map<string, string>();
  readonly #steps = new Map<string, AgentStep>();
  readonly #stepKeys = new Map<string, string>();
  readonly #checkpoints = new Map<string, RunCheckpoint[]>();
  readonly #checkpointKeys = new Map<string, RunCheckpoint>();
  readonly #events = new Map<string, RunEvent[]>();
  readonly #eventKeys = new Map<string, RunEvent>();
  readonly #fences = new Map<string, number>();
  #eventCursor = 0n;
  readonly #now: () => string;

  constructor(options: { readonly now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  create(
    scope: TenantScope,
    run: AgentRun,
  ): Promise<{ readonly run: AgentRun; readonly created: boolean }> {
    const idem = scoped(scope, `idem:${run.idempotencyKey}`);
    const existingId = this.#idempotency.get(idem);
    if (existingId !== undefined) {
      return Promise.resolve({
        run: clone(this.#runs.get(scoped(scope, existingId))!),
        created: false,
      });
    }
    const key = scoped(scope, run.id);
    if (this.#runs.has(key)) throw new Error(`run already exists: ${run.id}`);
    this.#runs.set(key, clone(run));
    this.#idempotency.set(idem, run.id);
    return Promise.resolve({ run: clone(run), created: true });
  }

  get(scope: TenantScope, runId: string): Promise<AgentRun | undefined> {
    return Promise.resolve(cloneOptional(this.#runs.get(scoped(scope, runId))));
  }

  getByIdempotencyKey(
    scope: TenantScope,
    idempotencyKey: string,
  ): Promise<AgentRun | undefined> {
    const id = this.#idempotency.get(scoped(scope, `idem:${idempotencyKey}`));
    return id === undefined ? Promise.resolve(undefined) : this.get(scope, id);
  }

  acquireLease(
    scope: TenantScope,
    runId: string,
    options: LeaseOptions,
  ): Promise<AgentRun | undefined> {
    const key = scoped(scope, runId);
    const run = this.#runs.get(key);
    if (
      run === undefined ||
      isTerminal(run.status) ||
      run.status === "WAITING_FOR_REVIEW"
    ) {
      return Promise.resolve(undefined);
    }
    if (
      run.lease !== undefined &&
      Date.parse(run.lease.expiresAt) > Date.parse(options.now)
    ) {
      return Promise.resolve(undefined);
    }
    const token = (this.#fences.get(key) ?? 0) + 1;
    this.#fences.set(key, token);
    const next: AgentRun = {
      ...run,
      version: run.version + 1,
      updatedAt: options.now,
      lease: {
        ownerId: options.ownerId,
        fencingToken: token,
        expiresAt: new Date(
          Date.parse(options.now) + options.leaseMs,
        ).toISOString(),
      },
    };
    this.#runs.set(key, next);
    return Promise.resolve(clone(next));
  }

  heartbeatLease(
    scope: TenantScope,
    runId: string,
    ownerId: string,
    fencingToken: number,
    expiresAt: string,
  ): Promise<boolean> {
    const key = scoped(scope, runId);
    const run = this.#runs.get(key);
    if (
      run?.lease?.ownerId !== ownerId ||
      run.lease.fencingToken !== fencingToken
    ) {
      return Promise.resolve(false);
    }
    this.#runs.set(key, {
      ...run,
      updatedAt: this.#now(),
      lease: { ownerId, fencingToken, expiresAt },
    });
    return Promise.resolve(true);
  }

  mutate(
    scope: TenantScope,
    runId: string,
    expectedVersion: number,
    mutation: RunMutation,
    fencingToken?: number,
  ): Promise<AgentRun | undefined> {
    const key = scoped(scope, runId);
    const run = this.#runs.get(key);
    if (run === undefined || run.version !== expectedVersion) {
      return Promise.resolve(undefined);
    }
    if (
      fencingToken !== undefined &&
      run.lease?.fencingToken !== fencingToken
    ) {
      return Promise.resolve(undefined);
    }
    if (mutation.status !== undefined) {
      assertRunTransition(run.status, mutation.status);
    }
    const next = applyMutation(run, mutation, this.#now());
    this.#runs.set(key, next);
    return Promise.resolve(clone(next));
  }

  createStep(
    step: AgentStep,
  ): Promise<{ readonly step: AgentStep; readonly created: boolean }> {
    const scope = step as TenantScope;
    const idem = runScoped(scope, step.runId, `idem:${step.idempotencyKey}`);
    const existingId = this.#stepKeys.get(idem);
    if (existingId !== undefined) {
      return Promise.resolve({
        step: clone(this.#steps.get(runScoped(scope, step.runId, existingId))!),
        created: false,
      });
    }
    this.#steps.set(runScoped(scope, step.runId, step.id), clone(step));
    this.#stepKeys.set(idem, step.id);
    return Promise.resolve({ step: clone(step), created: true });
  }

  getStepByIdempotencyKey(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
  ): Promise<AgentStep | undefined> {
    const id = this.#stepKeys.get(
      runScoped(scope, runId, `idem:${idempotencyKey}`),
    );
    return Promise.resolve(
      id === undefined
        ? undefined
        : cloneOptional(this.#steps.get(runScoped(scope, runId, id))),
    );
  }

  completeStep(
    scope: TenantScope,
    runId: string,
    stepId: string,
    fencingToken: number,
    output: unknown,
    completedAt: string,
  ): Promise<AgentStep | undefined> {
    const key = runScoped(scope, runId, stepId);
    const step = this.#steps.get(key);
    const run = this.#runs.get(scoped(scope, runId));
    if (
      step === undefined ||
      step.fencingToken > fencingToken ||
      run?.lease?.fencingToken !== fencingToken
    ) {
      return Promise.resolve(undefined);
    }
    if (step.status === "COMPLETED") return Promise.resolve(clone(step));
    const next: AgentStep = {
      ...step,
      status: "COMPLETED",
      fencingToken,
      output: clone(output),
      completedAt,
      updatedAt: completedAt,
    };
    this.#steps.set(key, next);
    return Promise.resolve(clone(next));
  }

  listSteps(scope: TenantScope, runId: string): Promise<readonly AgentStep[]> {
    return Promise.resolve(
      [...this.#steps.values()]
        .filter(
          (step) =>
            step.organisationId === scope.organisationId &&
            step.projectId === scope.projectId &&
            step.runId === runId,
        )
        .sort((a, b) => a.ordinal - b.ordinal)
        .map(clone),
    );
  }

  append(
    scope: TenantScope,
    runId: string,
    type: string,
    data: unknown,
    createdAt: string,
    idempotencyKey?: string,
  ): Promise<RunEvent> {
    if (idempotencyKey !== undefined) {
      const existing = this.#eventKeys.get(
        runScoped(scope, runId, idempotencyKey),
      );
      if (existing !== undefined) return Promise.resolve(clone(existing));
    }
    this.#eventCursor++;
    const event: RunEvent = {
      ...scope,
      id: randomUUID(),
      runId,
      cursor: this.#eventCursor.toString(),
      type,
      data: clone(data),
      createdAt,
    };
    const key = scoped(scope, runId);
    this.#events.set(key, [...(this.#events.get(key) ?? []), event]);
    if (idempotencyKey !== undefined) {
      this.#eventKeys.set(runScoped(scope, runId, idempotencyKey), event);
    }
    return Promise.resolve(clone(event));
  }

  listEvents(
    scope: TenantScope,
    runId: string,
    afterCursor = "0",
    limit = 100,
  ): Promise<readonly RunEvent[]> {
    const after = BigInt(afterCursor);
    return Promise.resolve(
      (this.#events.get(scoped(scope, runId)) ?? [])
        .filter((event) => BigInt(event.cursor) > after)
        .slice(0, limit)
        .map(clone),
    );
  }

  getEventByIdempotencyKey(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
  ): Promise<RunEvent | undefined> {
    return Promise.resolve(
      cloneOptional(
        this.#eventKeys.get(runScoped(scope, runId, idempotencyKey)),
      ),
    );
  }

  save(
    scope: TenantScope,
    runId: string,
    input: Omit<
      RunCheckpoint,
      "id" | "organisationId" | "projectId" | "runId" | "sequence" | "checksum"
    >,
  ): Promise<StoredCheckpoint> {
    const idem = runScoped(scope, runId, input.idempotencyKey);
    const existing = this.#checkpointKeys.get(idem);
    if (existing !== undefined) {
      return Promise.resolve({ checkpoint: clone(existing), created: false });
    }
    const key = scoped(scope, runId);
    const records = this.#checkpoints.get(key) ?? [];
    const checkpoint: RunCheckpoint = {
      ...scope,
      id: randomUUID(),
      runId,
      sequence: records.length + 1,
      ...clone(input),
      checksum: checkpointChecksum(input),
    };
    this.#checkpoints.set(key, [...records, checkpoint]);
    this.#checkpointKeys.set(idem, checkpoint);
    return Promise.resolve({ checkpoint: clone(checkpoint), created: true });
  }

  latest(
    scope: TenantScope,
    runId: string,
  ): Promise<RunCheckpoint | undefined> {
    const records = this.#checkpoints.get(scoped(scope, runId)) ?? [];
    return Promise.resolve(cloneOptional(records.at(-1)));
  }

  listCheckpoints(
    scope: TenantScope,
    runId: string,
  ): Promise<readonly RunCheckpoint[]> {
    return Promise.resolve(
      (this.#checkpoints.get(scoped(scope, runId)) ?? []).map(clone),
    );
  }
}

interface MemoryQueueRecord {
  readonly message: QueueMessage;
  readonly lease?: QueueLease;
}

export class InMemoryRunQueue implements RunQueue {
  readonly #records = new Map<string, MemoryQueueRecord>();
  readonly #fences = new Map<string, number>();
  readonly #now: () => string;

  constructor(options: { readonly now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  enqueue(
    scope: TenantScope,
    runId: string,
    options: { readonly delayMs?: number; readonly attempt?: number } = {},
  ): Promise<void> {
    const key = scoped(scope, runId);
    if (this.#records.has(key)) return Promise.resolve();
    const now = Date.parse(this.#now());
    this.#records.set(key, {
      message: {
        ...scope,
        id: randomUUID(),
        runId,
        attempt: options.attempt ?? 0,
        availableAt: new Date(now + (options.delayMs ?? 0)).toISOString(),
      },
    });
    return Promise.resolve();
  }

  claim(options: QueueClaimOptions): Promise<QueueLease | undefined> {
    const now = Date.parse(options.now);
    for (const [key, record] of this.#records) {
      if (Date.parse(record.message.availableAt) > now) continue;
      if (
        record.lease !== undefined &&
        Date.parse(record.lease.expiresAt) > now
      ) {
        continue;
      }
      const fencingToken = (this.#fences.get(key) ?? 0) + 1;
      this.#fences.set(key, fencingToken);
      const lease: QueueLease = {
        message: clone(record.message),
        receipt: randomUUID(),
        ownerId: options.workerId,
        fencingToken,
        expiresAt: new Date(now + options.leaseMs).toISOString(),
      };
      this.#records.set(key, { ...record, lease });
      return Promise.resolve(clone(lease));
    }
    return Promise.resolve(undefined);
  }

  heartbeat(lease: QueueLease, expiresAt: string): Promise<boolean> {
    const key = scoped(lease.message, lease.message.runId);
    const record = this.#records.get(key);
    if (record?.lease?.receipt !== lease.receipt) return Promise.resolve(false);
    this.#records.set(key, {
      ...record,
      lease: { ...record.lease, expiresAt },
    });
    return Promise.resolve(true);
  }

  ack(lease: QueueLease): Promise<void> {
    const key = scoped(lease.message, lease.message.runId);
    if (this.#records.get(key)?.lease?.receipt === lease.receipt) {
      this.#records.delete(key);
    }
    return Promise.resolve();
  }

  retry(lease: QueueLease, availableAt: string): Promise<void> {
    const key = scoped(lease.message, lease.message.runId);
    const record = this.#records.get(key);
    if (record?.lease?.receipt !== lease.receipt) return Promise.resolve();
    this.#records.set(key, {
      message: {
        ...record.message,
        attempt: record.message.attempt + 1,
        availableAt,
      },
    });
    return Promise.resolve();
  }
}

export class InMemoryHumanReviewGateway implements HumanReviewGateway {
  readonly #reviews = new Map<
    string,
    { readonly request: ReviewRequest; readonly decision?: ReviewDecision }
  >();

  request(review: ReviewRequest): Promise<void> {
    const key = scoped(review, review.id);
    if (!this.#reviews.has(key)) {
      this.#reviews.set(key, { request: clone(review) });
    }
    return Promise.resolve();
  }

  decide(scope: TenantScope, decision: ReviewDecision): Promise<void> {
    const key = scoped(scope, decision.reviewId);
    const existing = this.#reviews.get(key);
    if (existing === undefined) throw new Error("review not found");
    if (
      existing.decision !== undefined &&
      existing.decision.decision !== decision.decision
    ) {
      throw new Error("review already has a different decision");
    }
    this.#reviews.set(key, {
      request: existing.request,
      decision: clone(decision),
    });
    return Promise.resolve();
  }

  get(
    scope: TenantScope,
    reviewId: string,
  ): Promise<
    | { readonly request: ReviewRequest; readonly decision?: ReviewDecision }
    | undefined
  > {
    return Promise.resolve(
      cloneOptional(this.#reviews.get(scoped(scope, reviewId))),
    );
  }
}

function applyMutation(
  run: AgentRun,
  mutation: RunMutation,
  updatedAt: string,
): AgentRun {
  const next: Record<string, unknown> = {
    ...run,
    ...mutation,
    version: run.version + 1,
    updatedAt,
  };
  delete next.clearLease;
  delete next.clearFailure;
  delete next.clearReview;
  delete next.clearFinishedAt;
  delete next.clearOutput;
  delete next.clearResultRefs;
  delete next.clearSandbox;
  if (mutation.clearLease === true) delete next.lease;
  if (mutation.clearFailure === true) delete next.failure;
  if (mutation.clearReview === true) delete next.reviewId;
  if (mutation.clearFinishedAt === true) delete next.finishedAt;
  if (mutation.clearOutput === true) delete next.output;
  if (mutation.clearResultRefs === true) {
    next.resultRefs = { evidenceRefs: [] };
  }
  if (mutation.clearSandbox === true) delete next.sandboxId;
  return next as unknown as AgentRun;
}

function checkpointChecksum(
  input: Pick<
    RunCheckpoint,
    "idempotencyKey" | "kind" | "payload" | "step" | "usage"
  >,
): string {
  const material = jsonRoundTrip({
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    payload: input.payload ?? null,
    step: input.step ?? null,
    usage: input.usage ?? null,
  });
  return createHash("sha256").update(stableJson(material)).digest("hex");
}

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}
