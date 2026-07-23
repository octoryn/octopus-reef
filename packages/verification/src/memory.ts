import { createHash, randomUUID } from "node:crypto";
import { canonicalHash, verifyEvidence, type Evidence } from "octopus-evidence";
import {
  compareVerificationDecimalCursors,
  parseVerificationDecimalCursor,
} from "./cursor.js";
import {
  bindVerificationEventData,
  verificationRunIdentity,
} from "./identity.js";
import type {
  SourceBundleStore,
  VerificationArtifactStore,
  VerificationDispatchInput,
  VerificationEventInput,
  VerificationEvidenceStore,
  VerificationOutboxRecord,
  VerificationQueue,
  VerificationStore,
} from "./ports.js";
import type {
  SourceBundleDescriptor,
  VerificationArtifact,
  VerificationCheckpoint,
  VerificationEvent,
  VerificationMutation,
  VerificationQueueLease,
  VerificationQueueMessage,
  VerificationRun,
  VerificationTenant,
} from "./types.js";

interface OutboxRow extends VerificationOutboxRecord {
  ownerId?: string;
  leaseExpiresAt?: string;
  publishedAt?: string;
  lastError?: string;
}

/** Deterministic reference implementation used by protocol and reliability tests. */
export class MemoryVerificationStore implements VerificationStore {
  readonly #runs = new Map<string, VerificationRun>();
  readonly #idempotency = new Map<string, string>();
  readonly #events = new Map<string, VerificationEvent[]>();
  readonly #eventKeys = new Map<string, VerificationEvent>();
  readonly #checkpoints = new Map<string, VerificationCheckpoint[]>();
  readonly #outbox = new Map<string, OutboxRow>();
  #cursor = 0n;
  #fence = 0;
  readonly #now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  createAndDispatch(
    run: VerificationRun,
    event: VerificationEventInput,
    dispatch: VerificationDispatchInput,
  ): Promise<{ run: VerificationRun; created: boolean }> {
    const tenant = tenantOf(run);
    const idemKey = idempotencyKey(tenant, run.idempotencyKey);
    const existingRef = this.#idempotency.get(idemKey);
    if (existingRef !== undefined) {
      const existing = this.#runs.get(runKey(tenant, existingRef));
      if (existing === undefined)
        throw new Error("verification idempotency index is corrupt");
      if (!sameIdentity(existing, run)) {
        throw new Error(
          "idempotency key conflicts with another verification identity",
        );
      }
      return Promise.resolve({ run: clone(existing), created: false });
    }
    const appended = this.#appendEvent(run, event);
    const stored = { ...clone(run), eventCursor: appended.cursor };
    this.#runs.set(runKey(tenant, run.runRef), stored);
    this.#idempotency.set(idemKey, run.runRef);
    this.#enqueueOutbox(tenant, run.runRef, dispatch);
    return Promise.resolve({ run: clone(stored), created: true });
  }

  get(
    tenant: VerificationTenant,
    runRef: string,
  ): Promise<VerificationRun | undefined> {
    return Promise.resolve(
      optionalClone(this.#runs.get(runKey(tenant, runRef))),
    );
  }

  getByIdempotencyKey(
    tenant: VerificationTenant,
    key: string,
  ): Promise<VerificationRun | undefined> {
    const runRef = this.#idempotency.get(idempotencyKey(tenant, key));
    return runRef === undefined
      ? Promise.resolve(undefined)
      : this.get(tenant, runRef);
  }

  mutateWithEvent(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    mutation: VerificationMutation,
    event: VerificationEventInput,
    fencingToken?: number,
  ): Promise<VerificationRun | undefined> {
    const current = this.#runs.get(runKey(tenant, runRef));
    if (!canMutate(current, expectedVersion, fencingToken))
      return Promise.resolve(undefined);
    const appended = this.#appendEvent(current, event);
    const next = mutate(current, mutation, appended.cursor, this.#now());
    this.#runs.set(runKey(tenant, runRef), next);
    return Promise.resolve(clone(next));
  }

  async mutateAndDispatch(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    mutation: VerificationMutation,
    event: VerificationEventInput,
    dispatch: VerificationDispatchInput,
  ): Promise<VerificationRun | undefined> {
    const next = await this.mutateWithEvent(
      tenant,
      runRef,
      expectedVersion,
      mutation,
      event,
    );
    if (next !== undefined) this.#enqueueOutbox(tenant, runRef, dispatch);
    return next;
  }

  acquireLease(
    tenant: VerificationTenant,
    runRef: string,
    ownerId: string,
    leaseMs: number,
    now: string,
  ): Promise<VerificationRun | undefined> {
    const key = runKey(tenant, runRef);
    const current = this.#runs.get(key);
    if (
      current === undefined ||
      ["completed", "failed", "cancelled"].includes(current.state) ||
      (current.lease !== undefined &&
        Date.parse(current.lease.expiresAt) > Date.parse(now))
    ) {
      return Promise.resolve(undefined);
    }
    const next: VerificationRun = {
      ...current,
      version: current.version + 1,
      updatedAt: now,
      lease: {
        ownerId,
        fencingToken: ++this.#fence,
        expiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
      },
    };
    this.#runs.set(key, next);
    return Promise.resolve(clone(next));
  }

  heartbeatLease(
    tenant: VerificationTenant,
    runRef: string,
    ownerId: string,
    fencingToken: number,
    expiresAt: string,
  ): Promise<boolean> {
    const key = runKey(tenant, runRef);
    const current = this.#runs.get(key);
    if (
      current?.lease?.ownerId !== ownerId ||
      current.lease.fencingToken !== fencingToken ||
      ["completed", "failed", "cancelled"].includes(current.state)
    ) {
      return Promise.resolve(false);
    }
    this.#runs.set(key, {
      ...current,
      lease: { ...current.lease, expiresAt },
      updatedAt: this.#now(),
    });
    return Promise.resolve(true);
  }

  assertFence(
    tenant: VerificationTenant,
    runRef: string,
    fencingToken: number,
  ): Promise<boolean> {
    const run = this.#runs.get(runKey(tenant, runRef));
    return Promise.resolve(
      run?.lease?.fencingToken === fencingToken &&
        Date.parse(run.lease.expiresAt) > Date.parse(this.#now()),
    );
  }

  saveCheckResult(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    attempt: number,
    result: VerificationRun["checks"][number],
    fencingToken: number,
    event: VerificationEventInput,
  ): Promise<VerificationRun | undefined> {
    const key = runKey(tenant, runRef);
    const current = this.#runs.get(key);
    if (
      !canMutate(current, expectedVersion, fencingToken) ||
      current.attempt !== attempt
    ) {
      return Promise.resolve(undefined);
    }
    const list = this.#checkpoints.get(key) ?? [];
    const existing = list.find(
      (checkpoint) =>
        checkpoint.attempt === attempt &&
        checkpoint.checkRef === result.checkRef,
    );
    if (existing !== undefined) return Promise.resolve(clone(current));
    const appended = this.#appendEvent(current, event);
    const checkpoint: VerificationCheckpoint = {
      ...tenant,
      id: randomUUID(),
      runRef,
      sequence: list.length + 1,
      attempt,
      checkRef: result.checkRef,
      result: clone(result),
      fencingToken,
      createdAt: event.createdAt,
    };
    this.#checkpoints.set(key, [...list, checkpoint]);
    const next = mutate(
      current,
      { checks: [...current.checks, result] },
      appended.cursor,
      this.#now(),
    );
    this.#runs.set(key, next);
    return Promise.resolve(clone(next));
  }

  checkpoints(
    tenant: VerificationTenant,
    runRef: string,
  ): Promise<readonly VerificationCheckpoint[]> {
    return Promise.resolve(
      clone(this.#checkpoints.get(runKey(tenant, runRef)) ?? []),
    );
  }

  events(
    tenant: VerificationTenant,
    runRef: string,
    afterCursor = "0",
    limit = 100,
  ): Promise<readonly VerificationEvent[]> {
    const cursor = parseVerificationDecimalCursor(afterCursor);
    const events = this.#events.get(runKey(tenant, runRef)) ?? [];
    return Promise.resolve(
      clone(
        events
          .filter(
            (event) =>
              compareVerificationDecimalCursors(event.cursor, cursor) > 0,
          )
          .slice(0, limit),
      ),
    );
  }

  claimOutbox(
    ownerId: string,
    leaseMs: number,
    limit = 25,
  ): Promise<readonly VerificationOutboxRecord[]> {
    const now = this.#now();
    const claimed: OutboxRow[] = [];
    for (const row of this.#outbox.values()) {
      if (
        claimed.length >= limit ||
        row.publishedAt !== undefined ||
        Date.parse(row.availableAt) > Date.parse(now) ||
        (row.leaseExpiresAt !== undefined &&
          Date.parse(row.leaseExpiresAt) > Date.parse(now))
      ) {
        continue;
      }
      const next = {
        ...row,
        ownerId,
        leaseExpiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
        deliveryAttempts: row.deliveryAttempts + 1,
      };
      this.#outbox.set(row.id, next);
      claimed.push(next);
    }
    return Promise.resolve(clone(claimed));
  }

  markOutboxPublished(id: string, ownerId: string): Promise<void> {
    const row = this.#outbox.get(id);
    if (row?.ownerId === ownerId)
      this.#outbox.set(id, { ...row, publishedAt: this.#now() });
    return Promise.resolve();
  }

  retryOutbox(
    id: string,
    ownerId: string,
    availableAt: string,
    error: string,
  ): Promise<void> {
    const row = this.#outbox.get(id);
    if (row?.ownerId === ownerId) {
      const { ownerId: _owner, leaseExpiresAt: _lease, ...rest } = row;
      void _owner;
      void _lease;
      this.#outbox.set(id, {
        ...rest,
        availableAt,
        lastError: error.slice(0, 2000),
      });
    }
    return Promise.resolve();
  }

  #appendEvent(
    run: VerificationRun,
    input: VerificationEventInput,
  ): VerificationEvent {
    const tenant = tenantOf(run);
    const semantic = `${runKey(tenant, run.runRef)}\0${input.idempotencyKey}`;
    const existing = this.#eventKeys.get(semantic);
    if (existing !== undefined) return existing;
    const event: VerificationEvent = {
      ...tenant,
      identity: verificationRunIdentity(run),
      id: randomUUID(),
      runRef: run.runRef,
      cursor: parseVerificationDecimalCursor((++this.#cursor).toString(10)),
      type: input.type,
      data: clone(
        bindVerificationEventData(input.data, verificationRunIdentity(run)),
      ),
      createdAt: input.createdAt,
    };
    const key = runKey(tenant, run.runRef);
    this.#events.set(key, [...(this.#events.get(key) ?? []), event]);
    this.#eventKeys.set(semantic, event);
    return event;
  }

  #enqueueOutbox(
    tenant: VerificationTenant,
    runRef: string,
    dispatch: VerificationDispatchInput,
  ): void {
    const semantic = `${runKey(tenant, runRef)}\0${dispatch.idempotencyKey}`;
    if (
      [...this.#outbox.values()].some((row) => row.idempotencyKey === semantic)
    )
      return;
    const row: OutboxRow = {
      ...tenant,
      id: randomUUID(),
      runRef,
      idempotencyKey: semantic,
      attempt: dispatch.attempt,
      availableAt: dispatch.availableAt,
      deliveryAttempts: 0,
    };
    this.#outbox.set(row.id, row);
  }
}

export class MemoryVerificationQueue implements VerificationQueue {
  readonly #messages: VerificationQueueMessage[] = [];
  readonly #leased = new Map<string, VerificationQueueLease>();
  readonly #now: () => string;
  readonly duplicateDeliveries: boolean;

  constructor(
    now: () => string = () => new Date().toISOString(),
    duplicateDeliveries = false,
  ) {
    this.#now = now;
    this.duplicateDeliveries = duplicateDeliveries;
  }

  enqueue(
    tenant: VerificationTenant,
    runRef: string,
    attempt: number,
    delayMs = 0,
  ): Promise<void> {
    const message: VerificationQueueMessage = {
      ...tenant,
      id: randomUUID(),
      runRef,
      attempt,
      availableAt: new Date(Date.parse(this.#now()) + delayMs).toISOString(),
    };
    this.#messages.push(message);
    if (this.duplicateDeliveries)
      this.#messages.push({ ...message, id: randomUUID() });
    return Promise.resolve();
  }

  claim(
    workerId: string,
    leaseMs: number,
    now: string,
  ): Promise<VerificationQueueLease | undefined> {
    const message = this.#messages.find((candidate) => {
      const current = this.#leased.get(candidate.id);
      return (
        Date.parse(candidate.availableAt) <= Date.parse(now) &&
        (current === undefined ||
          Date.parse(current.expiresAt) <= Date.parse(now))
      );
    });
    if (message === undefined) return Promise.resolve(undefined);
    const lease: VerificationQueueLease = {
      message: clone(message),
      receipt: randomUUID(),
      ownerId: workerId,
      expiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
    };
    this.#leased.set(message.id, lease);
    return Promise.resolve(lease);
  }

  heartbeat(
    lease: VerificationQueueLease,
    expiresAt: string,
  ): Promise<boolean> {
    const current = this.#leased.get(lease.message.id);
    if (current?.receipt !== lease.receipt) return Promise.resolve(false);
    this.#leased.set(lease.message.id, { ...current, expiresAt });
    return Promise.resolve(true);
  }

  ack(lease: VerificationQueueLease): Promise<void> {
    const index = this.#messages.findIndex(
      (message) => message.id === lease.message.id,
    );
    if (index >= 0) this.#messages.splice(index, 1);
    this.#leased.delete(lease.message.id);
    return Promise.resolve();
  }

  retry(lease: VerificationQueueLease, availableAt: string): Promise<void> {
    const message = this.#messages.find(
      (candidate) => candidate.id === lease.message.id,
    );
    if (message !== undefined) Object.assign(message, { availableAt });
    this.#leased.delete(lease.message.id);
    return Promise.resolve();
  }
}

export class MemoryArtifactStore implements VerificationArtifactStore {
  readonly #values = new Map<
    string,
    { tenant: VerificationTenant; value: Uint8Array }
  >();

  put(
    tenant: VerificationTenant,
    runRef: string,
    kind: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<VerificationArtifact> {
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const ref = `artifact:${createHash("sha256")
      .update(`${tenantKey(tenant)}\0${runRef}\0${kind}\0${digest}`)
      .digest("hex")}`;
    this.#values.set(ref, {
      tenant: clone(tenant),
      value: Uint8Array.from(content),
    });
    return Promise.resolve({
      ref,
      digest,
      kind,
      mediaType,
      size: content.byteLength,
    });
  }

  get(
    tenant: VerificationTenant,
    ref: string,
  ): Promise<Uint8Array | undefined> {
    const stored = this.#values.get(ref);
    return Promise.resolve(
      stored !== undefined && tenantKey(stored.tenant) === tenantKey(tenant)
        ? Uint8Array.from(stored.value)
        : undefined,
    );
  }
}

export class MemoryEvidenceStore implements VerificationEvidenceStore {
  readonly #values = new Map<
    string,
    { tenant: VerificationTenant; evidence: Evidence; digest: string }
  >();

  put(
    tenant: VerificationTenant,
    evidence: Evidence,
  ): Promise<{ ref: string; digest: string }> {
    if (!verifyEvidence(evidence)) throw new Error("refusing invalid Evidence");
    const digest = `sha256:${canonicalHash(evidence as never)}`;
    const ref = `evidence:${evidence.id}`;
    this.#values.set(ref, {
      tenant: clone(tenant),
      evidence: clone(evidence),
      digest,
    });
    return Promise.resolve({ ref, digest });
  }

  get(
    tenant: VerificationTenant,
    ref: string,
  ): Promise<{ ref: string; evidence: Evidence; digest: string } | undefined> {
    const stored = this.#values.get(ref);
    return Promise.resolve(
      stored !== undefined && tenantKey(stored.tenant) === tenantKey(tenant)
        ? { ref, evidence: clone(stored.evidence), digest: stored.digest }
        : undefined,
    );
  }
}

export class MemorySourceBundleStore implements SourceBundleStore {
  readonly #descriptors = new Map<string, SourceBundleDescriptor>();
  readonly #content = new Map<
    string,
    { tenant: VerificationTenant; value: Uint8Array }
  >();

  add(
    descriptor: SourceBundleDescriptor,
    content: Readonly<Record<string, Uint8Array>>,
  ): void {
    const tenant = tenantOf(descriptor);
    this.#descriptors.set(
      bundleKey(tenant, descriptor.sourceBundleRef),
      clone(descriptor),
    );
    for (const [ref, value] of Object.entries(content)) {
      this.#content.set(bundleKey(tenant, ref), {
        tenant: clone(tenant),
        value: Uint8Array.from(value),
      });
    }
  }

  descriptor(
    tenant: VerificationTenant,
    sourceBundleRef: string,
  ): Promise<SourceBundleDescriptor> {
    const value = this.#descriptors.get(bundleKey(tenant, sourceBundleRef));
    if (value === undefined)
      throw new Error("source bundle descriptor not found");
    return Promise.resolve(clone(value));
  }

  content(tenant: VerificationTenant, contentRef: string): Promise<Uint8Array> {
    const value = this.#content.get(bundleKey(tenant, contentRef));
    if (value === undefined) throw new Error("source bundle content not found");
    return Promise.resolve(Uint8Array.from(value.value));
  }
}

function mutate(
  current: VerificationRun,
  mutation: VerificationMutation,
  eventCursor: string,
  updatedAt: string,
): VerificationRun {
  let next: VerificationRun = {
    ...current,
    ...(mutation.state !== undefined ? { state: mutation.state } : {}),
    ...(mutation.attempt !== undefined ? { attempt: mutation.attempt } : {}),
    ...(mutation.checks !== undefined
      ? { checks: clone(mutation.checks) }
      : {}),
    ...(mutation.verdict !== undefined
      ? { verdict: clone(mutation.verdict) }
      : {}),
    ...(mutation.failure !== undefined
      ? { failure: clone(mutation.failure) }
      : {}),
    ...(mutation.startedAt !== undefined
      ? { startedAt: mutation.startedAt }
      : {}),
    ...(mutation.finishedAt !== undefined
      ? { finishedAt: mutation.finishedAt }
      : {}),
    ...(mutation.sandboxRef !== undefined
      ? { sandboxRef: mutation.sandboxRef }
      : {}),
    version: current.version + 1,
    eventCursor: parseVerificationDecimalCursor(
      mutation.eventCursor ?? eventCursor,
    ),
    updatedAt,
  };
  if (mutation.clearLease) {
    const { lease, ...withoutLease } = next;
    void lease;
    next = withoutLease;
  }
  if (mutation.clearFailure) {
    const { failure, ...withoutFailure } = next;
    void failure;
    next = withoutFailure;
  }
  if (mutation.clearVerdict) {
    const { verdict, ...withoutVerdict } = next;
    void verdict;
    next = withoutVerdict;
  }
  return next;
}

function canMutate(
  run: VerificationRun | undefined,
  version: number,
  fence: number | undefined,
): run is VerificationRun {
  return (
    run !== undefined &&
    run.version === version &&
    (fence === undefined || run.lease?.fencingToken === fence)
  );
}

function sameIdentity(a: VerificationRun, b: VerificationRun): boolean {
  return [
    "organisationRef",
    "projectRef",
    "candidateRef",
    "candidateDigest",
    "sourceBundleRef",
    "sourceBundleDigest",
    "verificationProfileRef",
    "verificationProfileVersion",
    "verificationProfileDigest",
  ].every(
    (key) =>
      (a as unknown as Record<string, unknown>)[key] ===
      (b as unknown as Record<string, unknown>)[key],
  );
}

function runKey(tenant: VerificationTenant, runRef: string): string {
  return `${tenantKey(tenant)}\0${runRef}`;
}

function idempotencyKey(tenant: VerificationTenant, key: string): string {
  return `${tenantKey(tenant)}\0${key}`;
}

function bundleKey(tenant: VerificationTenant, ref: string): string {
  return `${tenantKey(tenant)}\0${ref}`;
}

function tenantKey(tenant: VerificationTenant): string {
  return `${tenant.organisationRef}\0${tenant.projectRef}`;
}

function tenantOf(value: VerificationTenant): VerificationTenant {
  return {
    organisationRef: value.organisationRef,
    projectRef: value.projectRef,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function optionalClone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}
