import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentRunRepository,
  HumanReviewGateway,
  RunCheckpointStore,
  RunEventStore,
  RunQueue,
  RunDispatchInput,
  RunDispatchOutbox,
  RunDispatchRecord,
  RunEventInput,
  TransactionalRunDispatchStore,
} from "../ports.js";
import { PersistenceIdempotencyConflictError } from "../errors.js";
import { assertRunTransition } from "../state-machine.js";
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
} from "../types.js";
import { CONTROL_PLANE_MIGRATIONS } from "./migrations.js";

export interface PgResult<Row> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PgClientLike {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgResult<Row>>;
  release?(): void;
}

export interface PgPoolLike extends PgClientLike {
  connect?(): Promise<PgClientLike>;
  end?(): Promise<void>;
}

export interface PostgresConnectionOptions {
  readonly connectionString: string;
  readonly ssl?:
    | boolean
    | {
        readonly ca?: string;
        readonly rejectUnauthorized: boolean;
      };
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
}

export type PostgresConnection =
  string | PostgresConnectionOptions | PgPoolLike;

type PgPoolCtor = new (options: PostgresConnectionOptions) => PgPoolLike;

interface RunRow {
  readonly organisation_id: string;
  readonly project_id: string;
  readonly id: string;
  readonly idempotency_key: string;
  readonly project_ref: string;
  readonly baseline_revision_ref: string;
  readonly work_item_ref: string | null;
  readonly acceptance_ref: string | null;
  readonly task: string;
  readonly status: AgentRun["status"];
  readonly version: string | number;
  readonly attempt: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly started_at: unknown | null;
  readonly finished_at: unknown | null;
  readonly secret_refs: unknown;
  readonly budget: unknown;
  readonly usage: unknown;
  readonly config: unknown;
  readonly metadata: unknown;
  readonly result_refs: unknown;
  readonly lease_owner: string | null;
  readonly lease_expires_at: unknown | null;
  readonly fencing_token: string | number;
  readonly sandbox_id: string | null;
  readonly output: string | null;
  readonly failure: unknown | null;
  readonly review_id: string | null;
}

interface StepRow {
  readonly organisation_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly id: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly idempotency_key: string;
  readonly status: AgentStep["status"];
  readonly attempt: number;
  readonly fencing_token: string | number;
  readonly input: unknown | null;
  readonly output: unknown | null;
  readonly failure: unknown | null;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly completed_at: unknown | null;
}

interface CheckpointRow {
  readonly organisation_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly id: string;
  readonly idempotency_key: string;
  readonly sequence: number;
  readonly kind: RunCheckpoint["kind"];
  readonly payload: unknown;
  readonly step: unknown | null;
  readonly usage: unknown | null;
  readonly checksum: string;
  readonly fencing_token: string | number;
  readonly created_at: unknown;
}

interface EventRow {
  readonly organisation_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly id: string;
  readonly cursor: string | number;
  readonly type: string;
  readonly data: unknown;
  readonly created_at: unknown;
}

interface QueueRow {
  readonly organisation_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly id: string;
  readonly attempt: number;
  readonly available_at: unknown;
  readonly lease_owner: string;
  readonly lease_expires_at: unknown;
  readonly fencing_token: string | number;
  readonly receipt: string;
}

interface DispatchRow {
  readonly id: string | number;
  readonly organisation_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly idempotency_key: string;
  readonly attempt: number;
  readonly available_at: unknown;
  readonly delivery_attempts: number;
}

const RUN_COLUMNS = [
  "organisation_id",
  "project_id",
  "id",
  "idempotency_key",
  "project_ref",
  "baseline_revision_ref",
  "work_item_ref",
  "acceptance_ref",
  "task",
  "status",
  "version",
  "attempt",
  "created_at",
  "updated_at",
  "started_at",
  "finished_at",
  "secret_refs",
  "budget",
  "usage",
  "config",
  "metadata",
  "result_refs",
  "lease_owner",
  "lease_expires_at",
  "fencing_token",
  "sandbox_id",
  "output",
  "failure",
  "review_id",
].join(", ");

/** PostgreSQL implementation for runs, steps, checkpoints, events/outbox and queue. */
export class PostgresControlPlaneStore
  implements
    AgentRunRepository,
    RunEventStore,
    RunCheckpointStore,
    RunQueue,
    TransactionalRunDispatchStore
{
  readonly #pool: PgPoolLike;
  readonly #ownsPool: boolean;
  readonly #now: () => string;

  constructor(
    connection: PostgresConnection,
    options: { readonly now?: () => string } = {},
  ) {
    if (!isPgPool(connection)) {
      this.#pool = createPgPool(connection);
      this.#ownsPool = true;
    } else {
      this.#pool = connection;
      this.#ownsPool = false;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async migrate(): Promise<void> {
    await this.#transaction(async (client) => {
      for (const migration of CONTROL_PLANE_MIGRATIONS) {
        await client.query(migration.sql);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end?.();
  }

  async create(
    scope: TenantScope,
    run: AgentRun,
  ): Promise<{ readonly run: AgentRun; readonly created: boolean }> {
    return this.#createWithClient(this.#pool, scope, run);
  }

  async createRunAndDispatch(
    scope: TenantScope,
    run: AgentRun,
    event: RunEventInput,
    dispatch: RunDispatchInput,
  ): Promise<{ readonly run: AgentRun; readonly created: boolean }> {
    return this.#transaction(async (client) => {
      const stored = await this.#createWithClient(client, scope, run);
      if (!stored.created) return stored;
      await this.#appendWithClient(client, scope, run.id, event);
      await this.#insertDispatch(
        client,
        scope,
        run.id,
        dispatch,
        run.createdAt,
      );
      return stored;
    });
  }

  async get(scope: TenantScope, runId: string): Promise<AgentRun | undefined> {
    const result = await this.#pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs
       WHERE organisation_id=$1 AND project_id=$2 AND id=$3`,
      [scope.organisationId, scope.projectId, runId],
    );
    return optional(result.rows[0], runFromRow);
  }

  async getByIdempotencyKey(
    scope: TenantScope,
    idempotencyKey: string,
  ): Promise<AgentRun | undefined> {
    const result = await this.#pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs
       WHERE organisation_id=$1 AND project_id=$2 AND idempotency_key=$3`,
      [scope.organisationId, scope.projectId, idempotencyKey],
    );
    return optional(result.rows[0], runFromRow);
  }

  async acquireLease(
    scope: TenantScope,
    runId: string,
    options: LeaseOptions,
  ): Promise<AgentRun | undefined> {
    const expiresAt = new Date(
      Date.parse(options.now) + options.leaseMs,
    ).toISOString();
    const result = await this.#pool.query<RunRow>(
      `UPDATE agent_runs SET
         lease_owner=$4, lease_expires_at=$5, fencing_token=fencing_token+1,
         version=version+1, updated_at=$6
       WHERE organisation_id=$1 AND project_id=$2 AND id=$3
         AND status NOT IN ('COMPLETED','FAILED','CANCELLED','BUDGET_EXCEEDED','WAITING_FOR_REVIEW')
         AND (lease_owner IS NULL OR lease_expires_at <= $6)
       RETURNING ${RUN_COLUMNS}`,
      [
        scope.organisationId,
        scope.projectId,
        runId,
        options.ownerId,
        expiresAt,
        options.now,
      ],
    );
    return optional(result.rows[0], runFromRow);
  }

  async heartbeatLease(
    scope: TenantScope,
    runId: string,
    ownerId: string,
    fencingToken: number,
    expiresAt: string,
  ): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE agent_runs SET lease_expires_at=$6, updated_at=$7
       WHERE organisation_id=$1 AND project_id=$2 AND id=$3
         AND lease_owner=$4 AND fencing_token=$5
         AND status NOT IN ('COMPLETED','FAILED','CANCELLED','BUDGET_EXCEEDED','WAITING_FOR_REVIEW')`,
      [
        scope.organisationId,
        scope.projectId,
        runId,
        ownerId,
        fencingToken,
        expiresAt,
        this.#now(),
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async mutate(
    scope: TenantScope,
    runId: string,
    expectedVersion: number,
    mutation: RunMutation,
    fencingToken?: number,
  ): Promise<AgentRun | undefined> {
    const current = await this.get(scope, runId);
    if (current === undefined || current.version !== expectedVersion)
      return undefined;
    if (mutation.status !== undefined) {
      assertRunTransition(current.status, mutation.status);
    }
    return this.#mutateWithClient(
      this.#pool,
      scope,
      runId,
      expectedVersion,
      mutation,
      fencingToken,
    );
  }

  async mutateRunAndDispatch(
    scope: TenantScope,
    runId: string,
    expectedVersion: number,
    mutation: RunMutation,
    event: RunEventInput,
    dispatch: RunDispatchInput,
    fencingToken?: number,
  ): Promise<AgentRun | undefined> {
    return this.#transaction(async (client) => {
      const locked = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM agent_runs
         WHERE organisation_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
        [scope.organisationId, scope.projectId, runId],
      );
      const current = optional(locked.rows[0], runFromRow);
      if (current === undefined || current.version !== expectedVersion) {
        return undefined;
      }
      if (mutation.status !== undefined) {
        assertRunTransition(current.status, mutation.status);
      }
      const updated = await this.#mutateWithClient(
        client,
        scope,
        runId,
        expectedVersion,
        mutation,
        fencingToken,
      );
      if (updated === undefined) return undefined;
      await this.#appendWithClient(client, scope, runId, event);
      await this.#insertDispatch(
        client,
        scope,
        runId,
        dispatch,
        event.createdAt,
      );
      return updated;
    });
  }

  async createStep(
    step: AgentStep,
  ): Promise<{ readonly step: AgentStep; readonly created: boolean }> {
    const result = await this.#pool.query<StepRow>(
      `INSERT INTO agent_steps (
        organisation_id,project_id,run_id,id,ordinal,kind,idempotency_key,status,
        attempt,fencing_token,input,output,failure,created_at,updated_at,completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16)
      ON CONFLICT (organisation_id,project_id,run_id,idempotency_key) DO NOTHING
      RETURNING *`,
      [
        step.organisationId,
        step.projectId,
        step.runId,
        step.id,
        step.ordinal,
        step.kind,
        step.idempotencyKey,
        step.status,
        step.attempt,
        step.fencingToken,
        jsonNullable(step.input),
        jsonNullable(step.output),
        jsonNullable(step.failure),
        step.createdAt,
        step.updatedAt,
        step.completedAt ?? null,
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined)
      return { step: stepFromRow(inserted), created: true };
    const existing = await this.getStepByIdempotencyKey(
      step,
      step.runId,
      step.idempotencyKey,
    );
    if (existing === undefined) throw new Error("step conflict without row");
    return { step: existing, created: false };
  }

  async getStepByIdempotencyKey(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
  ): Promise<AgentStep | undefined> {
    const result = await this.#pool.query<StepRow>(
      `SELECT * FROM agent_steps WHERE organisation_id=$1 AND project_id=$2
       AND run_id=$3 AND idempotency_key=$4`,
      [scope.organisationId, scope.projectId, runId, idempotencyKey],
    );
    return optional(result.rows[0], stepFromRow);
  }

  async completeStep(
    scope: TenantScope,
    runId: string,
    stepId: string,
    fencingToken: number,
    output: unknown,
    completedAt: string,
  ): Promise<AgentStep | undefined> {
    const result = await this.#pool.query<StepRow>(
      `UPDATE agent_steps s SET status='COMPLETED', output=$6::jsonb,
        completed_at=$7, updated_at=$7, fencing_token=$5
       FROM agent_runs r
       WHERE s.organisation_id=$1 AND s.project_id=$2 AND s.run_id=$3 AND s.id=$4
         AND r.organisation_id=s.organisation_id AND r.project_id=s.project_id AND r.id=s.run_id
         AND r.fencing_token=$5 AND s.fencing_token <= $5
       RETURNING s.*`,
      [
        scope.organisationId,
        scope.projectId,
        runId,
        stepId,
        fencingToken,
        jsonNullable(output),
        completedAt,
      ],
    );
    return optional(result.rows[0], stepFromRow);
  }

  async listSteps(
    scope: TenantScope,
    runId: string,
  ): Promise<readonly AgentStep[]> {
    const result = await this.#pool.query<StepRow>(
      `SELECT * FROM agent_steps WHERE organisation_id=$1 AND project_id=$2
       AND run_id=$3 ORDER BY ordinal`,
      [scope.organisationId, scope.projectId, runId],
    );
    return result.rows.map(stepFromRow);
  }

  async save(
    scope: TenantScope,
    runId: string,
    input: Omit<
      RunCheckpoint,
      "id" | "organisationId" | "projectId" | "runId" | "sequence" | "checksum"
    >,
  ): Promise<StoredCheckpoint> {
    return this.#transaction(async (client) => {
      const existing = await client.query<CheckpointRow>(
        `SELECT * FROM run_checkpoints WHERE organisation_id=$1 AND project_id=$2
         AND run_id=$3 AND idempotency_key=$4`,
        [scope.organisationId, scope.projectId, runId, input.idempotencyKey],
      );
      if (existing.rows[0] !== undefined) {
        return {
          checkpoint: checkpointFromRow(existing.rows[0]),
          created: false,
        };
      }
      const locked = await client.query<{
        readonly fencing_token: string | number;
      }>(
        `SELECT fencing_token FROM agent_runs WHERE organisation_id=$1 AND project_id=$2
         AND id=$3 FOR UPDATE`,
        [scope.organisationId, scope.projectId, runId],
      );
      if (Number(locked.rows[0]?.fencing_token) !== input.fencingToken) {
        throw new Error(`stale fencing token for checkpoint on ${runId}`);
      }
      const sequence = await client.query<{ readonly sequence: number }>(
        `SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM run_checkpoints
         WHERE organisation_id=$1 AND project_id=$2 AND run_id=$3`,
        [scope.organisationId, scope.projectId, runId],
      );
      const digest = checkpointChecksum(input);
      const inserted = await client.query<CheckpointRow>(
        `INSERT INTO run_checkpoints (
          organisation_id,project_id,run_id,id,idempotency_key,sequence,kind,payload,
          step,usage,checksum,fencing_token,created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13) RETURNING *`,
        [
          scope.organisationId,
          scope.projectId,
          runId,
          randomUUID(),
          input.idempotencyKey,
          sequence.rows[0]?.sequence ?? 1,
          input.kind,
          json(input.payload),
          jsonNullable(input.step),
          jsonNullable(input.usage),
          digest,
          input.fencingToken,
          input.createdAt,
        ],
      );
      return {
        checkpoint: checkpointFromRow(inserted.rows[0]!),
        created: true,
      };
    });
  }

  async latest(
    scope: TenantScope,
    runId: string,
  ): Promise<RunCheckpoint | undefined> {
    const result = await this.#pool.query<CheckpointRow>(
      `SELECT * FROM run_checkpoints WHERE organisation_id=$1 AND project_id=$2
       AND run_id=$3 ORDER BY sequence DESC LIMIT 1`,
      [scope.organisationId, scope.projectId, runId],
    );
    return optional(result.rows[0], checkpointFromRow);
  }

  async listCheckpoints(
    scope: TenantScope,
    runId: string,
  ): Promise<readonly RunCheckpoint[]> {
    const result = await this.#pool.query<CheckpointRow>(
      `SELECT * FROM run_checkpoints WHERE organisation_id=$1 AND project_id=$2
       AND run_id=$3 ORDER BY sequence`,
      [scope.organisationId, scope.projectId, runId],
    );
    return result.rows.map(checkpointFromRow);
  }

  async append(
    scope: TenantScope,
    runId: string,
    type: string,
    data: unknown,
    createdAt: string,
    idempotencyKey?: string,
  ): Promise<RunEvent> {
    return this.#transaction((client) =>
      this.#appendWithClient(client, scope, runId, {
        type,
        data,
        createdAt,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      }),
    );
  }

  async listEvents(
    scope: TenantScope,
    runId: string,
    afterCursor = "0",
    limit = 100,
  ): Promise<readonly RunEvent[]> {
    const result = await this.#pool.query<EventRow>(
      `SELECT organisation_id,project_id,run_id,id,cursor,type,data,created_at
       FROM run_events WHERE organisation_id=$1 AND project_id=$2 AND run_id=$3
         AND cursor>$4::bigint ORDER BY cursor LIMIT $5`,
      [scope.organisationId, scope.projectId, runId, afterCursor, limit],
    );
    return result.rows.map(eventFromRow);
  }

  async getEventByIdempotencyKey(
    scope: TenantScope,
    runId: string,
    idempotencyKey: string,
  ): Promise<RunEvent | undefined> {
    const result = await this.#pool.query<EventRow>(
      `SELECT organisation_id,project_id,run_id,id,cursor,type,data,created_at
       FROM run_events WHERE organisation_id=$1 AND project_id=$2 AND run_id=$3
         AND idempotency_key=$4`,
      [scope.organisationId, scope.projectId, runId, idempotencyKey],
    );
    return optional(result.rows[0], eventFromRow);
  }

  async enqueue(
    scope: TenantScope,
    runId: string,
    options: { readonly delayMs?: number; readonly attempt?: number } = {},
  ): Promise<void> {
    const availableAt = new Date(
      Date.parse(this.#now()) + (options.delayMs ?? 0),
    ).toISOString();
    await this.#pool.query(
      `INSERT INTO run_queue (
        organisation_id,project_id,run_id,id,attempt,available_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (organisation_id,project_id,run_id) DO UPDATE SET
        available_at=LEAST(run_queue.available_at,excluded.available_at),
        attempt=GREATEST(run_queue.attempt,excluded.attempt)`,
      [
        scope.organisationId,
        scope.projectId,
        runId,
        randomUUID(),
        options.attempt ?? 0,
        availableAt,
      ],
    );
  }

  async claim(options: QueueClaimOptions): Promise<QueueLease | undefined> {
    return this.#transaction(async (client) => {
      const receipt = randomUUID();
      const expiresAt = new Date(
        Date.parse(options.now) + options.leaseMs,
      ).toISOString();
      const result = await client.query<QueueRow>(
        `WITH candidate AS (
          SELECT organisation_id,project_id,run_id FROM run_queue
          WHERE available_at <= $1 AND (lease_owner IS NULL OR lease_expires_at <= $1)
          ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE run_queue q SET
          lease_owner=$2, lease_expires_at=$3, fencing_token=q.fencing_token+1, receipt=$4
        FROM candidate c WHERE q.organisation_id=c.organisation_id
          AND q.project_id=c.project_id AND q.run_id=c.run_id
        RETURNING q.*`,
        [options.now, options.workerId, expiresAt, receipt],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return queueLeaseFromRow(row);
    });
  }

  async heartbeat(lease: QueueLease, expiresAt: string): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE run_queue SET lease_expires_at=$6 WHERE organisation_id=$1
       AND project_id=$2 AND run_id=$3 AND receipt=$4 AND fencing_token=$5`,
      [
        lease.message.organisationId,
        lease.message.projectId,
        lease.message.runId,
        lease.receipt,
        lease.fencingToken,
        expiresAt,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async ack(lease: QueueLease): Promise<void> {
    await this.#pool.query(
      `DELETE FROM run_queue WHERE organisation_id=$1 AND project_id=$2
       AND run_id=$3 AND receipt=$4 AND fencing_token=$5`,
      [
        lease.message.organisationId,
        lease.message.projectId,
        lease.message.runId,
        lease.receipt,
        lease.fencingToken,
      ],
    );
  }

  async retry(lease: QueueLease, availableAt: string): Promise<void> {
    await this.#pool.query(
      `UPDATE run_queue SET attempt=attempt+1, available_at=$6,
        lease_owner=NULL,lease_expires_at=NULL,receipt=NULL
       WHERE organisation_id=$1 AND project_id=$2 AND run_id=$3
         AND receipt=$4 AND fencing_token=$5`,
      [
        lease.message.organisationId,
        lease.message.projectId,
        lease.message.runId,
        lease.receipt,
        lease.fencingToken,
        availableAt,
      ],
    );
  }

  /** Database connectivity plus the complete 0.1.2 schema, not process liveness. */
  async readiness(): Promise<{
    readonly ready: boolean;
    readonly database: string;
    readonly schemaVersion: "0.1.2";
  }> {
    const result = await this.#pool.query<{
      readonly database: string;
      readonly runs: string | null;
      readonly checkpoints: string | null;
      readonly events: string | null;
      readonly dispatch: string | null;
    }>(
      `SELECT current_database() AS database,
        to_regclass('public.agent_runs')::text AS runs,
        to_regclass('public.run_checkpoints')::text AS checkpoints,
        to_regclass('public.run_events')::text AS events,
        to_regclass('public.run_dispatch_outbox')::text AS dispatch`,
    );
    const row = result.rows[0];
    return {
      ready:
        row !== undefined &&
        row.runs !== null &&
        row.checkpoints !== null &&
        row.events !== null &&
        row.dispatch !== null,
      database: row?.database ?? "unknown",
      schemaVersion: "0.1.2",
    };
  }

  async #createWithClient(
    client: PgClientLike,
    scope: TenantScope,
    run: AgentRun,
  ): Promise<{ readonly run: AgentRun; readonly created: boolean }> {
    const result = await client.query<RunRow>(
      `INSERT INTO agent_runs (
        organisation_id, project_id, id, idempotency_key, project_ref,
        baseline_revision_ref, work_item_ref, acceptance_ref, task, status,
        version, attempt,
        created_at, updated_at, started_at, finished_at, secret_refs, budget,
        usage, config, metadata, result_refs, lease_owner, lease_expires_at,
        fencing_token, sandbox_id, output, failure, review_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,
        $18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25,
        $26,$27,$28::jsonb,$29
      ) ON CONFLICT (organisation_id, project_id, idempotency_key) DO NOTHING
      RETURNING ${RUN_COLUMNS}`,
      [
        scope.organisationId,
        scope.projectId,
        run.id,
        run.idempotencyKey,
        run.projectRef,
        run.baselineRevisionRef,
        run.workItemRef ?? null,
        run.acceptanceRef ?? null,
        run.task,
        run.status,
        run.version,
        run.attempt,
        run.createdAt,
        run.updatedAt,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        json(run.secretRefs),
        json(run.budget),
        json(run.usage),
        json(run.config),
        json(run.metadata),
        json(run.resultRefs),
        run.lease?.ownerId ?? null,
        run.lease?.expiresAt ?? null,
        run.lease?.fencingToken ?? 0,
        run.sandboxId ?? null,
        run.output ?? null,
        jsonNullable(run.failure),
        run.reviewId ?? null,
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) {
      return { run: runFromRow(inserted), created: true };
    }
    const existing = await client.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs
       WHERE organisation_id=$1 AND project_id=$2 AND idempotency_key=$3`,
      [scope.organisationId, scope.projectId, run.idempotencyKey],
    );
    if (existing.rows[0] === undefined) {
      throw new Error("run insert conflicted but row was not found");
    }
    return { run: runFromRow(existing.rows[0]), created: false };
  }

  async #mutateWithClient(
    client: PgClientLike,
    scope: TenantScope,
    runId: string,
    expectedVersion: number,
    mutation: RunMutation,
    fencingToken?: number,
  ): Promise<AgentRun | undefined> {
    const result = await client.query<RunRow>(
      `UPDATE agent_runs SET
        status=COALESCE($5,status), attempt=COALESCE($6,attempt),
        usage=COALESCE($7::jsonb,usage),
        sandbox_id=CASE WHEN $20 THEN NULL ELSE COALESCE($8,sandbox_id) END,
        output=CASE WHEN $21 THEN NULL ELSE COALESCE($9,output) END,
        result_refs=CASE WHEN $23 THEN '{"evidenceRefs":[]}'::jsonb
          ELSE COALESCE($10::jsonb,result_refs) END,
        failure=CASE WHEN $11 THEN NULL ELSE COALESCE($12::jsonb,failure) END,
        review_id=CASE WHEN $13 THEN NULL ELSE COALESCE($14,review_id) END,
        started_at=COALESCE($15,started_at),
        finished_at=CASE WHEN $22 THEN NULL ELSE COALESCE($16,finished_at) END,
        lease_owner=CASE WHEN $17 THEN NULL ELSE lease_owner END,
        lease_expires_at=CASE WHEN $17 THEN NULL ELSE lease_expires_at END,
        version=version+1, updated_at=$18
       WHERE organisation_id=$1 AND project_id=$2 AND id=$3 AND version=$4
         AND ($19::bigint IS NULL OR fencing_token=$19)
       RETURNING ${RUN_COLUMNS}`,
      [
        scope.organisationId,
        scope.projectId,
        runId,
        expectedVersion,
        mutation.status ?? null,
        mutation.attempt ?? null,
        mutation.usage === undefined ? null : json(mutation.usage),
        mutation.sandboxId ?? null,
        mutation.output ?? null,
        mutation.resultRefs === undefined ? null : json(mutation.resultRefs),
        mutation.clearFailure === true,
        jsonNullable(mutation.failure),
        mutation.clearReview === true,
        mutation.reviewId ?? null,
        mutation.startedAt ?? null,
        mutation.finishedAt ?? null,
        mutation.clearLease === true,
        this.#now(),
        fencingToken ?? null,
        mutation.clearSandbox === true,
        mutation.clearOutput === true,
        mutation.clearFinishedAt === true,
        mutation.clearResultRefs === true,
      ],
    );
    return optional(result.rows[0], runFromRow);
  }

  async #appendWithClient(
    client: PgClientLike,
    scope: TenantScope,
    runId: string,
    input: Omit<RunEventInput, "idempotencyKey"> & {
      readonly idempotencyKey?: string;
    },
  ): Promise<RunEvent> {
    const id = randomUUID();
    const inserted = await client.query<EventRow>(
      `INSERT INTO run_events (
        id,organisation_id,project_id,run_id,idempotency_key,type,data,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      ON CONFLICT (organisation_id,project_id,run_id,idempotency_key) DO UPDATE
        SET idempotency_key=excluded.idempotency_key
      RETURNING organisation_id,project_id,run_id,id,cursor,type,data,created_at`,
      [
        id,
        scope.organisationId,
        scope.projectId,
        runId,
        input.idempotencyKey ?? null,
        input.type,
        json(input.data),
        input.createdAt,
      ],
    );
    const event = eventFromRow(inserted.rows[0]!);
    if (
      input.idempotencyKey !== undefined &&
      (event.type !== input.type || !isDeepStrictEqual(event.data, input.data))
    ) {
      throw new PersistenceIdempotencyConflictError(input.idempotencyKey);
    }
    await client.query(
      `INSERT INTO run_outbox (
        event_id,organisation_id,project_id,run_id,payload,created_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(event_id) DO NOTHING`,
      [
        event.id,
        scope.organisationId,
        scope.projectId,
        runId,
        json(event),
        event.createdAt,
      ],
    );
    return event;
  }

  async #insertDispatch(
    client: PgClientLike,
    scope: TenantScope,
    runId: string,
    input: RunDispatchInput,
    createdAt: string,
  ): Promise<void> {
    const result = await client.query<DispatchRow>(
      `INSERT INTO run_dispatch_outbox (
        organisation_id,project_id,run_id,idempotency_key,attempt,
        available_at,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (organisation_id,project_id,run_id,idempotency_key) DO UPDATE
        SET idempotency_key=excluded.idempotency_key
      RETURNING id,organisation_id,project_id,run_id,idempotency_key,attempt,
        available_at,delivery_attempts`,
      [
        scope.organisationId,
        scope.projectId,
        runId,
        input.idempotencyKey,
        input.attempt,
        input.availableAt,
        createdAt,
      ],
    );
    if (result.rows[0]?.attempt !== input.attempt) {
      throw new PersistenceIdempotencyConflictError(input.idempotencyKey);
    }
  }

  async #transaction<T>(
    work: (client: PgClientLike) => Promise<T>,
  ): Promise<T> {
    const client = (await this.#pool.connect?.()) ?? this.#pool;
    await client.query("BEGIN");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }
}

export class PostgresHumanReviewGateway implements HumanReviewGateway {
  readonly #pool: PgPoolLike;
  readonly #ownsPool: boolean;

  constructor(connection: PostgresConnection) {
    if (!isPgPool(connection)) {
      this.#pool = createPgPool(connection);
      this.#ownsPool = true;
    } else {
      this.#pool = connection;
      this.#ownsPool = false;
    }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end?.();
  }

  async request(review: ReviewRequest): Promise<void> {
    await this.#pool.query(
      `INSERT INTO run_reviews (
        organisation_id,project_id,id,run_id,reason,context,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING`,
      [
        review.organisationId,
        review.projectId,
        review.id,
        review.runId,
        review.reason,
        jsonNullable(review.context),
        review.createdAt,
      ],
    );
  }

  async decide(scope: TenantScope, decision: ReviewDecision): Promise<void> {
    const result = await this.#pool.query(
      `UPDATE run_reviews SET decision=$4,actor_ref=$5,decision_reason=$6,decided_at=$7
       WHERE organisation_id=$1 AND project_id=$2 AND id=$3
         AND (decision IS NULL OR decision=$4)`,
      [
        scope.organisationId,
        scope.projectId,
        decision.reviewId,
        decision.decision,
        decision.actorRef,
        decision.reason ?? null,
        decision.decidedAt,
      ],
    );
    if ((result.rowCount ?? 0) !== 1)
      throw new Error("review not found or already decided");
  }

  async get(
    scope: TenantScope,
    reviewId: string,
  ): Promise<
    | { readonly request: ReviewRequest; readonly decision?: ReviewDecision }
    | undefined
  > {
    const result = await this.#pool.query<{
      readonly organisation_id: string;
      readonly project_id: string;
      readonly id: string;
      readonly run_id: string;
      readonly reason: string;
      readonly context: unknown | null;
      readonly created_at: unknown;
      readonly decision: ReviewDecision["decision"] | null;
      readonly actor_ref: string | null;
      readonly decision_reason: string | null;
      readonly decided_at: unknown | null;
    }>(
      `SELECT * FROM run_reviews WHERE organisation_id=$1 AND project_id=$2 AND id=$3`,
      [scope.organisationId, scope.projectId, reviewId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const request: ReviewRequest = {
      organisationId: row.organisation_id,
      projectId: row.project_id,
      id: row.id,
      runId: row.run_id,
      reason: row.reason,
      ...(row.context !== null ? { context: row.context } : {}),
      createdAt: iso(row.created_at),
    };
    if (
      row.decision === null ||
      row.actor_ref === null ||
      row.decided_at === null
    ) {
      return { request };
    }
    return {
      request,
      decision: {
        reviewId: row.id,
        decision: row.decision,
        actorRef: row.actor_ref,
        ...(row.decision_reason !== null
          ? { reason: row.decision_reason }
          : {}),
        decidedAt: iso(row.decided_at),
      },
    };
  }
}

export interface OutboxRecord {
  readonly id: string;
  readonly event: RunEvent;
}

export class PostgresOutbox {
  readonly #pool: PgPoolLike;
  readonly #ownsPool: boolean;
  readonly #now: () => string;

  constructor(
    connection: PostgresConnection,
    now: () => string = () => new Date().toISOString(),
  ) {
    if (!isPgPool(connection)) {
      this.#pool = createPgPool(connection);
      this.#ownsPool = true;
    } else {
      this.#pool = connection;
      this.#ownsPool = false;
    }
    this.#now = now;
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end?.();
  }

  async claim(
    ownerId: string,
    leaseMs: number,
    limit = 100,
  ): Promise<readonly OutboxRecord[]> {
    const expiresAt = new Date(Date.parse(this.#now()) + leaseMs).toISOString();
    const result = await this.#pool.query<{
      readonly id: string | number;
      readonly payload: unknown;
    }>(
      `WITH candidates AS (
        SELECT id FROM run_outbox WHERE published_at IS NULL
          AND (lease_owner IS NULL OR lease_expires_at <= $1)
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
      ) UPDATE run_outbox o SET lease_owner=$3,lease_expires_at=$4,attempts=attempts+1
      FROM candidates c WHERE o.id=c.id RETURNING o.id,o.payload`,
      [this.#now(), limit, ownerId, expiresAt],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      event: parse(row.payload) as RunEvent,
    }));
  }

  async published(id: string, ownerId: string): Promise<void> {
    await this.#pool.query(
      `UPDATE run_outbox SET published_at=$3,lease_owner=NULL,lease_expires_at=NULL
       WHERE id=$1::bigint AND lease_owner=$2`,
      [id, ownerId, this.#now()],
    );
  }
}

/** Lease-based dispatcher for the transactional queue outbox. */
export class PostgresDispatchOutbox implements RunDispatchOutbox {
  readonly #pool: PgPoolLike;
  readonly #ownsPool: boolean;
  readonly #now: () => string;

  constructor(
    connection: PostgresConnection,
    now: () => string = () => new Date().toISOString(),
  ) {
    if (!isPgPool(connection)) {
      this.#pool = createPgPool(connection);
      this.#ownsPool = true;
    } else {
      this.#pool = connection;
      this.#ownsPool = false;
    }
    this.#now = now;
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end?.();
  }

  async claim(
    ownerId: string,
    leaseMs: number,
    limit = 100,
  ): Promise<readonly RunDispatchRecord[]> {
    const now = this.#now();
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = await this.#pool.query<DispatchRow>(
      `WITH candidates AS (
        SELECT id FROM run_dispatch_outbox
        WHERE dispatched_at IS NULL AND available_at <= $1
          AND (lease_owner IS NULL OR lease_expires_at <= $1)
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
      ) UPDATE run_dispatch_outbox o SET
        lease_owner=$3,lease_expires_at=$4,
        delivery_attempts=delivery_attempts+1,last_error=NULL
      FROM candidates c WHERE o.id=c.id
      RETURNING o.id,o.organisation_id,o.project_id,o.run_id,
        o.idempotency_key,o.attempt,o.available_at,o.delivery_attempts`,
      [now, limit, ownerId, expiresAt],
    );
    return result.rows.map(dispatchFromRow);
  }

  async published(id: string, ownerId: string): Promise<void> {
    await this.#pool.query(
      `UPDATE run_dispatch_outbox SET
        dispatched_at=$3,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL
       WHERE id=$1::bigint AND lease_owner=$2 AND dispatched_at IS NULL`,
      [id, ownerId, this.#now()],
    );
  }

  async retry(
    id: string,
    ownerId: string,
    availableAt: string,
    error: string,
  ): Promise<void> {
    await this.#pool.query(
      `UPDATE run_dispatch_outbox SET
        available_at=$3,lease_owner=NULL,lease_expires_at=NULL,last_error=$4
       WHERE id=$1::bigint AND lease_owner=$2 AND dispatched_at IS NULL`,
      [id, ownerId, availableAt, error.slice(0, 4_000)],
    );
  }
}

function runFromRow(row: RunRow): AgentRun {
  return {
    organisationId: row.organisation_id,
    projectId: row.project_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    projectRef: row.project_ref,
    baselineRevisionRef: row.baseline_revision_ref,
    ...(row.work_item_ref !== null ? { workItemRef: row.work_item_ref } : {}),
    ...(row.acceptance_ref !== null
      ? { acceptanceRef: row.acceptance_ref }
      : {}),
    task: row.task,
    status: row.status,
    version: Number(row.version),
    attempt: row.attempt,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.started_at !== null ? { startedAt: iso(row.started_at) } : {}),
    ...(row.finished_at !== null ? { finishedAt: iso(row.finished_at) } : {}),
    secretRefs: parse(row.secret_refs) as AgentRun["secretRefs"],
    budget: parse(row.budget) as AgentRun["budget"],
    usage: parse(row.usage) as AgentRun["usage"],
    config: parse(row.config) as AgentRun["config"],
    metadata: parse(row.metadata) as AgentRun["metadata"],
    resultRefs: parse(row.result_refs) as AgentRun["resultRefs"],
    ...(row.lease_owner !== null && row.lease_expires_at !== null
      ? {
          lease: {
            ownerId: row.lease_owner,
            fencingToken: Number(row.fencing_token),
            expiresAt: iso(row.lease_expires_at),
          },
        }
      : {}),
    ...(row.sandbox_id !== null ? { sandboxId: row.sandbox_id } : {}),
    ...(row.output !== null ? { output: row.output } : {}),
    ...(row.failure !== null
      ? { failure: parse(row.failure) as NonNullable<AgentRun["failure"]> }
      : {}),
    ...(row.review_id !== null ? { reviewId: row.review_id } : {}),
  };
}

function stepFromRow(row: StepRow): AgentStep {
  return {
    organisationId: row.organisation_id,
    projectId: row.project_id,
    runId: row.run_id,
    id: row.id,
    ordinal: row.ordinal,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempt: row.attempt,
    fencingToken: Number(row.fencing_token),
    ...(row.input !== null ? { input: parse(row.input) } : {}),
    ...(row.output !== null ? { output: parse(row.output) } : {}),
    ...(row.failure !== null
      ? { failure: parse(row.failure) as NonNullable<AgentStep["failure"]> }
      : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at !== null
      ? { completedAt: iso(row.completed_at) }
      : {}),
  };
}

function checkpointFromRow(row: CheckpointRow): RunCheckpoint {
  const checkpoint: RunCheckpoint = {
    organisationId: row.organisation_id,
    projectId: row.project_id,
    runId: row.run_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    sequence: row.sequence,
    kind: row.kind,
    payload: parse(row.payload),
    ...(row.step !== null
      ? { step: parse(row.step) as NonNullable<RunCheckpoint["step"]> }
      : {}),
    ...(row.usage !== null
      ? { usage: parse(row.usage) as NonNullable<RunCheckpoint["usage"]> }
      : {}),
    checksum: row.checksum,
    fencingToken: Number(row.fencing_token),
    createdAt: iso(row.created_at),
  };
  if (checkpointChecksum(checkpoint) !== checkpoint.checksum) {
    throw new Error(`checkpoint checksum mismatch: ${checkpoint.id}`);
  }
  return checkpoint;
}

function eventFromRow(row: EventRow): RunEvent {
  return {
    organisationId: row.organisation_id,
    projectId: row.project_id,
    runId: row.run_id,
    id: row.id,
    cursor: String(row.cursor),
    type: row.type,
    data: parse(row.data),
    createdAt: iso(row.created_at),
  };
}

function queueLeaseFromRow(row: QueueRow): QueueLease {
  const message: QueueMessage = {
    organisationId: row.organisation_id,
    projectId: row.project_id,
    id: row.id,
    runId: row.run_id,
    attempt: row.attempt,
    availableAt: iso(row.available_at),
  };
  return {
    message,
    receipt: row.receipt,
    ownerId: row.lease_owner,
    fencingToken: Number(row.fencing_token),
    expiresAt: iso(row.lease_expires_at),
  };
}

function dispatchFromRow(row: DispatchRow): RunDispatchRecord {
  return {
    id: String(row.id),
    organisationId: row.organisation_id,
    projectId: row.project_id,
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    availableAt: iso(row.available_at),
    deliveryAttempts: row.delivery_attempts,
  };
}

function loadPgPool(): PgPoolCtor {
  const require = createRequire(import.meta.url);
  const loaded = require("pg") as { Pool?: PgPoolCtor };
  if (loaded.Pool === undefined) throw new Error("pg Pool is unavailable");
  return loaded.Pool;
}

function createPgPool(
  connection: string | PostgresConnectionOptions,
): PgPoolLike {
  const Pool = loadPgPool();
  return new Pool(
    typeof connection === "string"
      ? { connectionString: connection }
      : connection,
  );
}

function isPgPool(connection: PostgresConnection): connection is PgPoolLike {
  return typeof connection === "object" && "query" in connection;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[") &&
    !trimmed.startsWith('"') &&
    trimmed !== "null" &&
    trimmed !== "true" &&
    trimmed !== "false" &&
    !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed)
  ) {
    // pg has already decoded a JSONB string scalar.
    return value;
  }
  return JSON.parse(value) as unknown;
}

function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function jsonNullable(value: unknown): string | null {
  return value === undefined ? null : json(value);
}

function optional<Row, Value>(
  row: Row | undefined,
  map: (row: Row) => Value,
): Value | undefined {
  return row === undefined ? undefined : map(row);
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
