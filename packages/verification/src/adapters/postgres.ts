import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { VerificationConflictError } from "../errors.js";
import type {
  VerificationDispatchInput,
  VerificationEventInput,
  VerificationOutboxRecord,
  VerificationQueue,
  VerificationStore,
} from "../ports.js";
import type {
  VerificationCheckpoint,
  VerificationCheckResult,
  VerificationEvent,
  VerificationMutation,
  VerificationQueueLease,
  VerificationRun,
  VerificationTenant,
} from "../types.js";
import { VERIFICATION_MIGRATIONS } from "./migrations.js";
import {
  parseVerificationDecimalCursor,
  type VerificationDecimalCursor,
} from "../cursor.js";
import { parseVerificationRunResponse } from "../client-schema.js";

export interface VerificationPgResult<Row> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface VerificationPgClientLike {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<VerificationPgResult<Row>>;
  release?(): void;
}

export interface VerificationPgPoolLike extends VerificationPgClientLike {
  connect?(): Promise<VerificationPgClientLike>;
  end?(): Promise<void>;
}

export interface VerificationPostgresConnectionOptions {
  readonly connectionString: string;
  readonly ssl?:
    boolean | { readonly ca?: string; readonly rejectUnauthorized: boolean };
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
}

export type VerificationPostgresConnection =
  string | VerificationPostgresConnectionOptions | VerificationPgPoolLike;

interface RunRow {
  readonly run_data: unknown;
  readonly version: string | number;
  readonly state: VerificationRun["state"];
  readonly lease_owner: string | null;
  readonly lease_expires_at: unknown | null;
  readonly fencing_token: string | number | null;
}

interface EventRow {
  readonly cursor: string;
  readonly id: string;
  readonly organisation_ref: string;
  readonly project_ref: string;
  readonly run_ref: string;
  readonly type: string;
  readonly data: unknown;
  readonly created_at: unknown;
}

interface CheckpointRow {
  readonly id: string;
  readonly organisation_ref: string;
  readonly project_ref: string;
  readonly run_ref: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly check_ref: string;
  readonly result: unknown;
  readonly fencing_token: string | number;
  readonly created_at: unknown;
}

interface OutboxRow {
  readonly id: string | number;
  readonly organisation_ref: string;
  readonly project_ref: string;
  readonly run_ref: string;
  readonly idempotency_key: string;
  readonly attempt: number;
  readonly available_at: unknown;
  readonly delivery_attempts: number;
}

interface QueueRow {
  readonly id: string;
  readonly organisation_ref: string;
  readonly project_ref: string;
  readonly run_ref: string;
  readonly attempt: number;
  readonly available_at: unknown;
  readonly receipt: string;
  readonly lease_owner: string;
  readonly lease_expires_at: unknown;
}

/** PostgreSQL request/checkpoint/event/outbox/lease store and reference queue. */
export class PostgresVerificationStore
  implements VerificationStore, VerificationQueue
{
  readonly #pool: VerificationPgPoolLike;
  readonly #ownsPool: boolean;
  readonly #now: () => string;

  constructor(
    connection: VerificationPostgresConnection,
    options: { readonly now?: () => string } = {},
  ) {
    if (isPool(connection)) {
      this.#pool = connection;
      this.#ownsPool = false;
    } else {
      this.#pool = createPool(connection);
      this.#ownsPool = true;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async migrate(): Promise<void> {
    await this.#transaction(async (client) => {
      // PostgreSQL's IF NOT EXISTS is not a concurrency primitive: two fresh
      // API/Worker tasks can still race while creating a sequence or table.
      // Hold one database-local transaction lock across the entire ordered set.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('octopus-reef/verification/migrations', 0))",
      );
      for (const migration of VERIFICATION_MIGRATIONS)
        await client.query(migration.sql);
    });
  }

  async ready(): Promise<void> {
    const result = await this.#pool.query<{ readonly ok: number }>(
      "SELECT 1 AS ok",
    );
    if (result.rows[0]?.ok !== 1)
      throw new Error("verification PostgreSQL readiness failed");
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end?.();
  }

  createAndDispatch(
    run: VerificationRun,
    event: VerificationEventInput,
    dispatch: VerificationDispatchInput,
  ): Promise<{ readonly run: VerificationRun; readonly created: boolean }> {
    return this.#transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO verification_runs (
          organisation_ref, project_ref, run_ref, idempotency_key,
          candidate_ref, candidate_digest, source_bundle_ref, source_bundle_digest,
          verification_profile_ref, verification_profile_version, verification_profile_digest,
          state, version, attempt, event_cursor, run_data, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,$15::jsonb,$16,$17)
        ON CONFLICT DO NOTHING`,
        [
          run.organisationRef,
          run.projectRef,
          run.runRef,
          run.idempotencyKey,
          run.candidateRef,
          run.candidateDigest,
          run.sourceBundleRef,
          run.sourceBundleDigest,
          run.verificationProfileRef,
          run.verificationProfileVersion,
          run.verificationProfileDigest,
          run.state,
          run.version,
          run.attempt,
          json(run),
          run.createdAt,
          run.updatedAt,
        ],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        const existing = await this.#getByIdempotency(
          client,
          run,
          run.idempotencyKey,
          false,
        );
        if (existing === undefined || !sameIdentity(existing, run)) {
          throw new VerificationConflictError(
            "idempotency key conflicts with another verification identity",
          );
        }
        return { run: existing, created: false };
      }
      const cursor = await this.#insertEvent(client, run, event);
      const stored = { ...run, eventCursor: cursor };
      await this.#writeRun(client, stored);
      await this.#insertOutbox(client, run, dispatch);
      return { run: stored, created: true };
    });
  }

  async get(
    tenant: VerificationTenant,
    runRef: string,
  ): Promise<VerificationRun | undefined> {
    const result = await this.#pool.query<RunRow>(
      `SELECT run_data, version, state, lease_owner, lease_expires_at, fencing_token
       FROM verification_runs WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3`,
      [tenant.organisationRef, tenant.projectRef, runRef],
    );
    return result.rows[0] === undefined
      ? undefined
      : runFromRow(result.rows[0]);
  }

  getByIdempotencyKey(
    tenant: VerificationTenant,
    idempotencyKey: string,
  ): Promise<VerificationRun | undefined> {
    return this.#getByIdempotency(this.#pool, tenant, idempotencyKey, false);
  }

  mutateWithEvent(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    mutation: VerificationMutation,
    event: VerificationEventInput,
    fencingToken?: number,
  ): Promise<VerificationRun | undefined> {
    return this.#mutate(
      tenant,
      runRef,
      expectedVersion,
      mutation,
      event,
      fencingToken,
    );
  }

  mutateAndDispatch(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    mutation: VerificationMutation,
    event: VerificationEventInput,
    dispatch: VerificationDispatchInput,
  ): Promise<VerificationRun | undefined> {
    return this.#mutate(
      tenant,
      runRef,
      expectedVersion,
      mutation,
      event,
      undefined,
      dispatch,
    );
  }

  acquireLease(
    tenant: VerificationTenant,
    runRef: string,
    ownerId: string,
    leaseMs: number,
    now: string,
  ): Promise<VerificationRun | undefined> {
    return this.#transaction(async (client) => {
      const current = await this.#lockedRun(client, tenant, runRef);
      if (
        current === undefined ||
        terminal(current.state) ||
        (current.lease !== undefined &&
          Date.parse(current.lease.expiresAt) > Date.parse(now))
      )
        return undefined;
      const fenceResult = await client.query<{
        readonly token: string | number;
      }>("SELECT nextval('verification_fencing_token_seq') AS token");
      const fencingToken = Number(fenceResult.rows[0]!.token);
      const next: VerificationRun = {
        ...current,
        version: current.version + 1,
        updatedAt: now,
        lease: {
          ownerId,
          fencingToken,
          expiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
        },
      };
      await this.#writeRun(client, next);
      return next;
    });
  }

  heartbeatLease(
    tenant: VerificationTenant,
    runRef: string,
    ownerId: string,
    fencingToken: number,
    expiresAt: string,
  ): Promise<boolean> {
    return this.#transaction(async (client) => {
      const current = await this.#lockedRun(client, tenant, runRef);
      if (
        current?.lease?.ownerId !== ownerId ||
        current.lease.fencingToken !== fencingToken ||
        terminal(current.state)
      )
        return false;
      await this.#writeRun(client, {
        ...current,
        updatedAt: this.#now(),
        lease: { ...current.lease, expiresAt },
      });
      return true;
    });
  }

  async assertFence(
    tenant: VerificationTenant,
    runRef: string,
    fencingToken: number,
  ): Promise<boolean> {
    const result = await this.#pool.query<{ readonly matches: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM verification_runs
        WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3
          AND fencing_token=$4 AND lease_expires_at > $5 AND state NOT IN ('completed','failed','cancelled')
      ) AS matches`,
      [
        tenant.organisationRef,
        tenant.projectRef,
        runRef,
        fencingToken,
        this.#now(),
      ],
    );
    return result.rows[0]?.matches === true;
  }

  saveCheckResult(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    attempt: number,
    result: VerificationCheckResult,
    fencingToken: number,
    event: VerificationEventInput,
  ): Promise<VerificationRun | undefined> {
    return this.#transaction(async (client) => {
      const current = await this.#lockedRun(client, tenant, runRef);
      if (
        !mutable(current, expectedVersion, fencingToken, this.#now()) ||
        current.attempt !== attempt
      ) {
        return undefined;
      }
      const duplicate = await client.query(
        `SELECT 1 FROM verification_checkpoints
         WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3 AND attempt=$4 AND check_ref=$5`,
        [
          tenant.organisationRef,
          tenant.projectRef,
          runRef,
          attempt,
          result.checkRef,
        ],
      );
      if (duplicate.rows.length > 0) return current;
      const cursor = await this.#insertEvent(client, current, event);
      const sequenceResult = await client.query<{ readonly sequence: number }>(
        `SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM verification_checkpoints
         WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3`,
        [tenant.organisationRef, tenant.projectRef, runRef],
      );
      await client.query(
        `INSERT INTO verification_checkpoints (
          id, organisation_ref, project_ref, run_ref, sequence, attempt,
          check_ref, result, fencing_token, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [
          randomUUID(),
          tenant.organisationRef,
          tenant.projectRef,
          runRef,
          sequenceResult.rows[0]!.sequence,
          attempt,
          result.checkRef,
          json(result),
          fencingToken,
          event.createdAt,
        ],
      );
      const next = applyMutation(
        current,
        { checks: [...current.checks, result] },
        cursor,
        this.#now(),
      );
      await this.#writeRun(client, next);
      return next;
    });
  }

  async checkpoints(
    tenant: VerificationTenant,
    runRef: string,
  ): Promise<readonly VerificationCheckpoint[]> {
    const result = await this.#pool.query<CheckpointRow>(
      `SELECT id, organisation_ref, project_ref, run_ref, sequence, attempt,
              check_ref, result, fencing_token, created_at
       FROM verification_checkpoints
       WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3 ORDER BY sequence`,
      [tenant.organisationRef, tenant.projectRef, runRef],
    );
    return result.rows.map(checkpointFromRow);
  }

  async events(
    tenant: VerificationTenant,
    runRef: string,
    afterCursor = "0",
    limit = 100,
  ): Promise<readonly VerificationEvent[]> {
    const cursor = parseVerificationDecimalCursor(afterCursor);
    const result = await this.#pool.query<EventRow>(
      `SELECT cursor, id, organisation_ref, project_ref, run_ref, type, data, created_at
       FROM verification_events
       WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3 AND cursor > $4
       ORDER BY cursor LIMIT $5`,
      [
        tenant.organisationRef,
        tenant.projectRef,
        runRef,
        cursor,
        Math.max(1, Math.min(limit, 1000)),
      ],
    );
    return result.rows.map(eventFromRow);
  }

  claimOutbox(
    ownerId: string,
    leaseMs: number,
    limit = 25,
  ): Promise<readonly VerificationOutboxRecord[]> {
    const now = this.#now();
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    return this.#transaction(async (client) => {
      const result = await client.query<OutboxRow>(
        `WITH candidates AS (
          SELECT id FROM verification_outbox
          WHERE published_at IS NULL AND available_at <= $1
            AND (lease_owner IS NULL OR lease_expires_at <= $1)
          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
        )
        UPDATE verification_outbox o SET lease_owner=$3, lease_expires_at=$4,
          delivery_attempts=o.delivery_attempts+1
        FROM candidates c WHERE o.id=c.id
        RETURNING o.id, o.organisation_ref, o.project_ref, o.run_ref,
          o.idempotency_key, o.attempt, o.available_at, o.delivery_attempts`,
        [now, Math.max(1, Math.min(limit, 100)), ownerId, expiresAt],
      );
      return result.rows.map(outboxFromRow);
    });
  }

  async markOutboxPublished(id: string, ownerId: string): Promise<void> {
    await this.#pool.query(
      `UPDATE verification_outbox SET published_at=$3, lease_owner=NULL, lease_expires_at=NULL
       WHERE id=$1 AND lease_owner=$2 AND published_at IS NULL`,
      [id, ownerId, this.#now()],
    );
  }

  async retryOutbox(
    id: string,
    ownerId: string,
    availableAt: string,
    error: string,
  ): Promise<void> {
    await this.#pool.query(
      `UPDATE verification_outbox SET available_at=$3, last_error=$4,
         lease_owner=NULL, lease_expires_at=NULL
       WHERE id=$1 AND lease_owner=$2 AND published_at IS NULL`,
      [id, ownerId, availableAt, error.slice(0, 4096)],
    );
  }

  async enqueue(
    tenant: VerificationTenant,
    runRef: string,
    attempt: number,
    delayMs = 0,
  ): Promise<void> {
    const availableAt = new Date(
      Date.parse(this.#now()) + delayMs,
    ).toISOString();
    await this.#pool.query(
      `INSERT INTO verification_queue (
        id, organisation_ref, project_ref, run_ref, attempt, available_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (organisation_ref, project_ref, run_ref, attempt) DO UPDATE
        SET available_at=LEAST(verification_queue.available_at, EXCLUDED.available_at)`,
      [
        randomUUID(),
        tenant.organisationRef,
        tenant.projectRef,
        runRef,
        attempt,
        availableAt,
      ],
    );
  }

  claim(
    workerId: string,
    leaseMs: number,
    now: string,
  ): Promise<VerificationQueueLease | undefined> {
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const receipt = randomUUID();
    return this.#transaction(async (client) => {
      const result = await client.query<QueueRow>(
        `WITH candidate AS (
          SELECT id FROM verification_queue
          WHERE available_at <= $1 AND (receipt IS NULL OR lease_expires_at <= $1)
          ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE verification_queue q SET lease_owner=$2, lease_expires_at=$3, receipt=$4
        FROM candidate c WHERE q.id=c.id
        RETURNING q.id, q.organisation_ref, q.project_ref, q.run_ref, q.attempt,
          q.available_at, q.receipt, q.lease_owner, q.lease_expires_at`,
        [now, workerId, expiresAt, receipt],
      );
      return result.rows[0] === undefined
        ? undefined
        : queueLeaseFromRow(result.rows[0]);
    });
  }

  async heartbeat(
    lease: VerificationQueueLease,
    expiresAt: string,
  ): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE verification_queue SET lease_expires_at=$4
       WHERE id=$1 AND receipt=$2 AND lease_owner=$3`,
      [lease.message.id, lease.receipt, lease.ownerId, expiresAt],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async ack(lease: VerificationQueueLease): Promise<void> {
    await this.#pool.query(
      "DELETE FROM verification_queue WHERE id=$1 AND receipt=$2 AND lease_owner=$3",
      [lease.message.id, lease.receipt, lease.ownerId],
    );
  }

  async retry(
    lease: VerificationQueueLease,
    availableAt: string,
  ): Promise<void> {
    await this.#pool.query(
      `UPDATE verification_queue SET available_at=$4, receipt=NULL,
         lease_owner=NULL, lease_expires_at=NULL
       WHERE id=$1 AND receipt=$2 AND lease_owner=$3`,
      [lease.message.id, lease.receipt, lease.ownerId, availableAt],
    );
  }

  #mutate(
    tenant: VerificationTenant,
    runRef: string,
    expectedVersion: number,
    mutation: VerificationMutation,
    event: VerificationEventInput,
    fencingToken?: number,
    dispatch?: VerificationDispatchInput,
  ): Promise<VerificationRun | undefined> {
    return this.#transaction(async (client) => {
      const current = await this.#lockedRun(client, tenant, runRef);
      if (!mutable(current, expectedVersion, fencingToken, this.#now()))
        return undefined;
      const existing = await client.query(
        `SELECT 1 FROM verification_events
         WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3 AND idempotency_key=$4`,
        [
          tenant.organisationRef,
          tenant.projectRef,
          runRef,
          event.idempotencyKey,
        ],
      );
      if (existing.rows.length > 0) return current;
      const cursor = await this.#insertEvent(client, current, event);
      const next = applyMutation(current, mutation, cursor, this.#now());
      await this.#writeRun(client, next);
      if (dispatch !== undefined)
        await this.#insertOutbox(client, current, dispatch);
      return next;
    });
  }

  async #lockedRun(
    client: VerificationPgClientLike,
    tenant: VerificationTenant,
    runRef: string,
  ): Promise<VerificationRun | undefined> {
    const result = await client.query<RunRow>(
      `SELECT run_data, version, state, lease_owner, lease_expires_at, fencing_token
       FROM verification_runs WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3
       FOR UPDATE`,
      [tenant.organisationRef, tenant.projectRef, runRef],
    );
    return result.rows[0] === undefined
      ? undefined
      : runFromRow(result.rows[0]);
  }

  async #getByIdempotency(
    client: VerificationPgClientLike,
    tenant: VerificationTenant,
    idempotencyKey: string,
    lock: boolean,
  ): Promise<VerificationRun | undefined> {
    const result = await client.query<RunRow>(
      `SELECT run_data, version, state, lease_owner, lease_expires_at, fencing_token
       FROM verification_runs WHERE organisation_ref=$1 AND project_ref=$2 AND idempotency_key=$3
       ${lock ? "FOR UPDATE" : ""}`,
      [tenant.organisationRef, tenant.projectRef, idempotencyKey],
    );
    return result.rows[0] === undefined
      ? undefined
      : runFromRow(result.rows[0]);
  }

  async #insertEvent(
    client: VerificationPgClientLike,
    run: VerificationRun,
    event: VerificationEventInput,
  ): Promise<VerificationDecimalCursor> {
    const result = await client.query<{ readonly cursor: string }>(
      `INSERT INTO verification_events (
        id, organisation_ref, project_ref, run_ref, idempotency_key, type, data, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING cursor`,
      [
        randomUUID(),
        run.organisationRef,
        run.projectRef,
        run.runRef,
        event.idempotencyKey,
        event.type,
        json(event.data),
        event.createdAt,
      ],
    );
    return parseVerificationDecimalCursor(
      result.rows[0]!.cursor,
      "persisted event cursor",
    );
  }

  async #insertOutbox(
    client: VerificationPgClientLike,
    run: VerificationRun,
    dispatch: VerificationDispatchInput,
  ): Promise<void> {
    await client.query(
      `INSERT INTO verification_outbox (
        organisation_ref, project_ref, run_ref, idempotency_key, attempt, available_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (organisation_ref, project_ref, run_ref, idempotency_key) DO NOTHING`,
      [
        run.organisationRef,
        run.projectRef,
        run.runRef,
        dispatch.idempotencyKey,
        dispatch.attempt,
        dispatch.availableAt,
      ],
    );
  }

  async #writeRun(
    client: VerificationPgClientLike,
    run: VerificationRun,
  ): Promise<void> {
    await client.query(
      `UPDATE verification_runs SET state=$4, version=$5, attempt=$6, event_cursor=$7,
         run_data=$8::jsonb, lease_owner=$9, lease_expires_at=$10,
         fencing_token=$11, updated_at=$12
       WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3`,
      [
        run.organisationRef,
        run.projectRef,
        run.runRef,
        run.state,
        run.version,
        run.attempt,
        run.eventCursor,
        json(run),
        run.lease?.ownerId ?? null,
        run.lease?.expiresAt ?? null,
        run.lease?.fencingToken ?? null,
        run.updatedAt,
      ],
    );
  }

  async #transaction<T>(
    work: (client: VerificationPgClientLike) => Promise<T>,
  ): Promise<T> {
    const client =
      this.#pool.connect === undefined
        ? this.#pool
        : await this.#pool.connect();
    await client.query("BEGIN");
    try {
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (client !== this.#pool) client.release?.();
    }
  }
}

function runFromRow(row: RunRow): VerificationRun {
  return parseVerificationRunResponse(row.run_data);
}

function mutable(
  current: VerificationRun | undefined,
  expectedVersion: number,
  fencingToken: number | undefined,
  now: string,
): current is VerificationRun {
  if (current === undefined || current.version !== expectedVersion)
    return false;
  if (fencingToken === undefined) return true;
  return (
    current.lease?.fencingToken === fencingToken &&
    Date.parse(current.lease.expiresAt) > Date.parse(now)
  );
}

function applyMutation(
  current: VerificationRun,
  mutation: VerificationMutation,
  eventCursor: string,
  updatedAt: string,
): VerificationRun {
  let next: VerificationRun = {
    ...current,
    ...(mutation.state === undefined ? {} : { state: mutation.state }),
    ...(mutation.attempt === undefined ? {} : { attempt: mutation.attempt }),
    ...(mutation.checks === undefined ? {} : { checks: mutation.checks }),
    ...(mutation.verdict === undefined ? {} : { verdict: mutation.verdict }),
    ...(mutation.failure === undefined ? {} : { failure: mutation.failure }),
    ...(mutation.startedAt === undefined
      ? {}
      : { startedAt: mutation.startedAt }),
    ...(mutation.finishedAt === undefined
      ? {}
      : { finishedAt: mutation.finishedAt }),
    ...(mutation.sandboxRef === undefined
      ? {}
      : { sandboxRef: mutation.sandboxRef }),
    version: current.version + 1,
    eventCursor: parseVerificationDecimalCursor(
      mutation.eventCursor ?? eventCursor,
      "persisted run event cursor",
    ),
    updatedAt,
  };
  if (mutation.clearLease) {
    const { lease, ...rest } = next;
    void lease;
    next = rest;
  }
  if (mutation.clearFailure) {
    const { failure, ...rest } = next;
    void failure;
    next = rest;
  }
  if (mutation.clearVerdict) {
    const { verdict, ...rest } = next;
    void verdict;
    next = rest;
  }
  return next;
}

function terminal(state: VerificationRun["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function sameIdentity(a: VerificationRun, b: VerificationRun): boolean {
  return isDeepStrictEqual(identity(a), identity(b));
}

function identity(run: VerificationRun): unknown {
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

function eventFromRow(row: EventRow): VerificationEvent {
  return {
    organisationRef: row.organisation_ref,
    projectRef: row.project_ref,
    id: row.id,
    runRef: row.run_ref,
    cursor: parseVerificationDecimalCursor(
      row.cursor,
      "persisted event cursor",
    ),
    type: row.type,
    data: row.data,
    createdAt: iso(row.created_at),
  };
}

function checkpointFromRow(row: CheckpointRow): VerificationCheckpoint {
  return {
    organisationRef: row.organisation_ref,
    projectRef: row.project_ref,
    id: row.id,
    runRef: row.run_ref,
    sequence: row.sequence,
    attempt: row.attempt,
    checkRef: row.check_ref,
    result: row.result as VerificationCheckResult,
    fencingToken: Number(row.fencing_token),
    createdAt: iso(row.created_at),
  };
}

function outboxFromRow(row: OutboxRow): VerificationOutboxRecord {
  return {
    id: String(row.id),
    organisationRef: row.organisation_ref,
    projectRef: row.project_ref,
    runRef: row.run_ref,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    availableAt: iso(row.available_at),
    deliveryAttempts: row.delivery_attempts,
  };
}

function queueLeaseFromRow(row: QueueRow): VerificationQueueLease {
  return {
    message: {
      id: row.id,
      organisationRef: row.organisation_ref,
      projectRef: row.project_ref,
      runRef: row.run_ref,
      attempt: row.attempt,
      availableAt: iso(row.available_at),
    },
    receipt: row.receipt,
    ownerId: row.lease_owner,
    expiresAt: iso(row.lease_expires_at),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function iso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

function isPool(
  value: VerificationPostgresConnection,
): value is VerificationPgPoolLike {
  return typeof value === "object" && value !== null && "query" in value;
}

type PoolConstructor = new (
  options: VerificationPostgresConnectionOptions,
) => VerificationPgPoolLike;

function createPool(
  connection: string | VerificationPostgresConnectionOptions,
): VerificationPgPoolLike {
  const require = createRequire(import.meta.url);
  const pg = require("pg") as { readonly Pool: PoolConstructor };
  return new pg.Pool(
    typeof connection === "string"
      ? { connectionString: connection }
      : connection,
  );
}
