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
import {
  parseVerificationCheckResultResponse,
  parseVerificationEventResponse,
  parseVerificationMaterializationResponse,
  parseVerificationRunResponse,
} from "../client-schema.js";
import {
  VERIFICATION_RUN_IDENTITY_KEYS,
  bindVerificationEventData,
  parseVerificationRunIdentity,
  verificationRunIdentity,
} from "../identity.js";
import type { VerificationRunIdentity } from "../types.js";

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
  readonly materialization_schema_version: string | null;
  readonly materialization_ref: string | null;
  readonly materialization_descriptor_ref: string | null;
  readonly materialization_descriptor_digest: string | null;
  readonly authoritative_source_bundle_digest: string | null;
  readonly builder_source_bundle_ref: string | null;
  readonly builder_source_bundle_digest: string | null;
  readonly builder_source_bundle_binding_ref: string | null;
  readonly builder_source_bundle_binding_digest: string | null;
  readonly materialization_entry_count: string | number | null;
  readonly materialization_total_bytes: string | number | null;
}

interface EventRow {
  readonly cursor: string;
  readonly id: string;
  readonly organisation_ref: string;
  readonly project_ref: string;
  readonly run_ref: string;
  readonly candidate_ref: string;
  readonly candidate_digest: string;
  readonly source_bundle_ref: string;
  readonly source_bundle_digest: string;
  readonly verification_profile_ref: string;
  readonly verification_profile_version: string;
  readonly verification_profile_digest: string;
  readonly type: string;
  readonly data: unknown;
  readonly created_at: unknown;
}

interface CheckpointRow {
  readonly id: string;
  readonly organisation_ref: string;
  readonly project_ref: string;
  readonly run_ref: string;
  readonly candidate_ref: string;
  readonly candidate_digest: string;
  readonly source_bundle_ref: string;
  readonly source_bundle_digest: string;
  readonly verification_profile_ref: string;
  readonly verification_profile_version: string;
  readonly verification_profile_digest: string;
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
    const result = await this.#pool.query<{ readonly ok: boolean }>(
      `SELECT
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema=current_schema()
            AND table_name='verification_runs'
            AND column_name='builder_source_bundle_binding_digest'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid='verification_runs'::regclass
            AND conname='verification_runs_materialization_identity_check'
            AND pg_get_constraintdef(oid) LIKE '%octopus.reef.materialization/v2%'
            AND pg_get_constraintdef(oid) LIKE '%num_nonnulls%'
            AND pg_get_constraintdef(oid) LIKE '%IS TRUE%'
        ) AS ok`,
    );
    if (result.rows[0]?.ok !== true)
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
      `SELECT run_data, version, state, lease_owner, lease_expires_at, fencing_token,
              materialization_schema_version, materialization_ref,
              materialization_descriptor_ref, materialization_descriptor_digest,
              authoritative_source_bundle_digest, builder_source_bundle_ref,
              builder_source_bundle_digest, builder_source_bundle_binding_ref,
              builder_source_bundle_binding_digest,
              materialization_entry_count, materialization_total_bytes
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
      `SELECT c.id, c.organisation_ref, c.project_ref, c.run_ref,
              r.candidate_ref, r.candidate_digest,
              r.source_bundle_ref, r.source_bundle_digest,
              r.verification_profile_ref, r.verification_profile_version,
              r.verification_profile_digest,
              c.sequence, c.attempt, c.check_ref, c.result,
              c.fencing_token, c.created_at
       FROM verification_checkpoints c
       JOIN verification_runs r
         ON r.organisation_ref=c.organisation_ref
        AND r.project_ref=c.project_ref
        AND r.run_ref=c.run_ref
       WHERE c.organisation_ref=$1 AND c.project_ref=$2 AND c.run_ref=$3
       ORDER BY c.sequence`,
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
      `SELECT e.cursor, e.id, e.organisation_ref, e.project_ref, e.run_ref,
              r.candidate_ref, r.candidate_digest,
              r.source_bundle_ref, r.source_bundle_digest,
              r.verification_profile_ref, r.verification_profile_version,
              r.verification_profile_digest,
              e.type, e.data, e.created_at
       FROM verification_events e
       JOIN verification_runs r
         ON r.organisation_ref=e.organisation_ref
        AND r.project_ref=e.project_ref
        AND r.run_ref=e.run_ref
       WHERE e.organisation_ref=$1 AND e.project_ref=$2
         AND e.run_ref=$3 AND e.cursor > $4
       ORDER BY e.cursor LIMIT $5`,
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
      `SELECT run_data, version, state, lease_owner, lease_expires_at, fencing_token,
              materialization_schema_version, materialization_ref,
              materialization_descriptor_ref, materialization_descriptor_digest,
              authoritative_source_bundle_digest, builder_source_bundle_ref,
              builder_source_bundle_digest, builder_source_bundle_binding_ref,
              builder_source_bundle_binding_digest,
              materialization_entry_count, materialization_total_bytes
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
      `SELECT run_data, version, state, lease_owner, lease_expires_at, fencing_token,
              materialization_schema_version, materialization_ref,
              materialization_descriptor_ref, materialization_descriptor_digest,
              authoritative_source_bundle_digest, builder_source_bundle_ref,
              builder_source_bundle_digest, builder_source_bundle_binding_ref,
              builder_source_bundle_binding_digest,
              materialization_entry_count, materialization_total_bytes
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
        json(
          bindVerificationEventData(event.data, verificationRunIdentity(run)),
        ),
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
         fencing_token=$11, updated_at=$12,
         materialization_schema_version=$13, materialization_ref=$14,
         materialization_descriptor_ref=$15,
         materialization_descriptor_digest=$16,
         authoritative_source_bundle_digest=$17,
         builder_source_bundle_ref=$18,
         builder_source_bundle_digest=$19,
         builder_source_bundle_binding_ref=$20,
         builder_source_bundle_binding_digest=$21,
         materialization_entry_count=$22, materialization_total_bytes=$23
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
        run.materialization?.schemaVersion ?? null,
        run.materialization?.ref ?? null,
        run.materialization?.runtimeDescriptorRef ?? null,
        run.materialization?.runtimeDescriptorDigest ?? null,
        run.materialization?.builderSourceBundleDigest ?? null,
        run.materialization?.builderSourceBundleRef ?? null,
        run.materialization?.builderSourceBundleDigest ?? null,
        run.materialization?.builderSourceBundleBindingRef ?? null,
        run.materialization?.builderSourceBundleBindingDigest ?? null,
        run.materialization?.entryCount ?? null,
        run.materialization?.totalBytes ?? null,
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
  if (
    row.materialization_schema_version === "octopus.reef.materialization/v1"
  ) {
    throw new Error(
      "persisted 0.3 materialization contract is incompatible with 0.4; process the run with the immutable 0.3 runtime",
    );
  }
  if (
    row.run_data === null ||
    typeof row.run_data !== "object" ||
    Array.isArray(row.run_data)
  ) {
    throw new Error("persisted verification run must be an object");
  }
  const run = row.run_data as Record<string, unknown>;
  const identity = parseVerificationRunIdentity(
    run,
    "persisted verification run identity",
  );
  const checks = run["checks"];
  if (!Array.isArray(checks)) {
    throw new Error("persisted verification run checks must be an array");
  }
  const verdict = run["verdict"];
  const parsed = parseVerificationRunResponse({
    ...run,
    checks: checks.map((check) => bindNestedIdentity(check, identity)),
    ...(verdict === undefined
      ? {}
      : { verdict: bindNestedIdentity(verdict, identity) }),
  });
  const columns = materializationFromRow(row);
  if (!isDeepStrictEqual(parsed.materialization, columns)) {
    throw new Error(
      "persisted verification materialization column/document mismatch",
    );
  }
  return parsed;
}

function materializationFromRow(
  row: RunRow,
): VerificationRun["materialization"] {
  const values = [
    row.materialization_schema_version,
    row.materialization_ref,
    row.materialization_descriptor_ref,
    row.materialization_descriptor_digest,
    row.authoritative_source_bundle_digest,
    row.builder_source_bundle_ref,
    row.builder_source_bundle_digest,
    row.builder_source_bundle_binding_ref,
    row.builder_source_bundle_binding_digest,
    row.materialization_entry_count,
    row.materialization_total_bytes,
  ];
  if (values.every((value) => value === null)) return undefined;
  if (
    row.materialization_schema_version === "octopus.reef.materialization/v1"
  ) {
    throw new Error(
      "persisted 0.3 materialization contract is incompatible with 0.4; process the run with the immutable 0.3 runtime",
    );
  }
  if (values.some((value) => value === null)) {
    throw new Error("persisted verification materialization is partial");
  }
  if (
    row.authoritative_source_bundle_digest !== row.builder_source_bundle_digest
  ) {
    throw new Error(
      "persisted Builder source bundle digest columns do not match",
    );
  }
  return parseVerificationMaterializationResponse({
    schemaVersion: row.materialization_schema_version,
    ref: row.materialization_ref,
    runtimeDescriptorRef: row.materialization_descriptor_ref,
    runtimeDescriptorDigest: row.materialization_descriptor_digest,
    builderSourceBundleRef: row.builder_source_bundle_ref,
    builderSourceBundleDigest: row.builder_source_bundle_digest,
    builderSourceBundleBindingRef: row.builder_source_bundle_binding_ref,
    builderSourceBundleBindingDigest: row.builder_source_bundle_binding_digest,
    entryCount: safePersistedCount(
      row.materialization_entry_count,
      "materialization entry count",
    ),
    totalBytes: safePersistedCount(
      row.materialization_total_bytes,
      "materialization total bytes",
    ),
  });
}

function safePersistedCount(
  value: string | number | null,
  name: string,
): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 0
  ) {
    throw new Error(`persisted ${name} is invalid`);
  }
  return number;
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
    ...(mutation.materialization === undefined
      ? {}
      : { materialization: mutation.materialization }),
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
  if (mutation.clearMaterialization) {
    const { materialization, ...rest } = next;
    void materialization;
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
  const identity = verificationRunIdentity({
    organisationRef: row.organisation_ref,
    projectRef: row.project_ref,
    candidateRef: row.candidate_ref,
    candidateDigest: row.candidate_digest,
    sourceBundleRef: row.source_bundle_ref,
    sourceBundleDigest: row.source_bundle_digest,
    verificationProfileRef: row.verification_profile_ref,
    verificationProfileVersion: row.verification_profile_version,
    verificationProfileDigest: row.verification_profile_digest,
    runRef: row.run_ref,
  });
  return parseVerificationEventResponse({
    organisationRef: identity.organisationRef,
    projectRef: identity.projectRef,
    identity,
    id: row.id,
    runRef: row.run_ref,
    cursor: parseVerificationDecimalCursor(
      row.cursor,
      "persisted event cursor",
    ),
    type: row.type,
    data: bindPersistedEventIdentity(row.data, identity),
    createdAt: iso(row.created_at),
  });
}

function bindPersistedEventIdentity(
  value: unknown,
  identity: VerificationRunIdentity,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted verification event data must be an object");
  }
  const data = value as Record<string, unknown>;
  const rawIdentity = data["identity"];
  if (
    rawIdentity === null ||
    typeof rawIdentity !== "object" ||
    Array.isArray(rawIdentity)
  ) {
    throw new Error("persisted verification event identity is missing");
  }
  const storedIdentity = rawIdentity as Record<string, unknown>;
  for (const key of VERIFICATION_RUN_IDENTITY_KEYS) {
    if (
      key !== "runRef" ||
      Object.prototype.hasOwnProperty.call(storedIdentity, key)
    ) {
      if (storedIdentity[key] !== identity[key]) {
        throw new Error(
          `persisted verification event identity mismatch: ${key}`,
        );
      }
    }
  }
  return { ...data, identity };
}

function checkpointFromRow(row: CheckpointRow): VerificationCheckpoint {
  const identity = verificationRunIdentity({
    organisationRef: row.organisation_ref,
    projectRef: row.project_ref,
    candidateRef: row.candidate_ref,
    candidateDigest: row.candidate_digest,
    sourceBundleRef: row.source_bundle_ref,
    sourceBundleDigest: row.source_bundle_digest,
    verificationProfileRef: row.verification_profile_ref,
    verificationProfileVersion: row.verification_profile_version,
    verificationProfileDigest: row.verification_profile_digest,
    runRef: row.run_ref,
  });
  return {
    organisationRef: row.organisation_ref,
    projectRef: row.project_ref,
    id: row.id,
    runRef: row.run_ref,
    sequence: row.sequence,
    attempt: row.attempt,
    checkRef: row.check_ref,
    result: parseVerificationCheckResultResponse(
      bindNestedIdentity(row.result, identity),
    ),
    fencingToken: Number(row.fencing_token),
    createdAt: iso(row.created_at),
  };
}

function bindNestedIdentity(
  value: unknown,
  identity: VerificationRunIdentity,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted verification identity-bound value is invalid");
  }
  const record = value as Record<string, unknown>;
  return {
    ...record,
    identity: record["identity"] ?? identity,
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
