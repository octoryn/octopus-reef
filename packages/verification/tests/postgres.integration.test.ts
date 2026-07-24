import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DeterministicSourceBundleMaterializer,
  DeterministicVerificationWorker,
  MemoryEvidenceStore,
  StaticVerificationProfileRegistry,
  VerificationDispatchPublisher,
  VerificationService,
  VerificationWorkerProcessCrash,
  computeBuilderSourceBundleDigest,
  defineTrustedProfile,
  type SourceBundleDescriptor,
  type VerificationRunRequest,
} from "../src/index.js";
import {
  PostgresVerificationStore,
  type VerificationPgPoolLike,
} from "../src/adapters/postgres.js";
import { VERIFICATION_MIGRATIONS } from "../src/adapters/migrations.js";
import {
  EnvironmentProfileSecretResolver,
  LocalSourceBundleStore,
  LocalVerificationArtifactStore,
  LocalVerificationEvidenceStore,
  LocalVerificationSandboxProvisioner,
} from "../src/adapters/local.js";

const databaseUrl = process.env["REEF_TEST_POSTGRES_URL"];

const materializationColumns = [
  "materialization_schema_version",
  "materialization_ref",
  "materialization_descriptor_ref",
  "materialization_descriptor_digest",
  "authoritative_source_bundle_digest",
  "builder_source_bundle_ref",
  "builder_source_bundle_digest",
  "builder_source_bundle_binding_ref",
  "builder_source_bundle_binding_digest",
  "materialization_entry_count",
  "materialization_total_bytes",
] as const;

type MaterializationColumn = (typeof materializationColumns)[number];
type MaterializationTuple = Readonly<
  Record<MaterializationColumn, string | number | null>
>;

test(
  "real PostgreSQL migrates 0.3 rows without reinterpreting the colliding materialization",
  {
    skip:
      databaseUrl === undefined
        ? "REEF_TEST_POSTGRES_URL is not configured"
        : false,
  },
  async () => {
    const admin = postgresPool(databaseUrl!);
    const schema = `reef_v030_upgrade_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(databaseUrl!);
    isolated.searchParams.set("options", `-csearch_path=${schema}`);
    const pool = postgresPool(isolated.toString());
    const store = new PostgresVerificationStore(pool);
    const digest = sha("0.3-source");
    const now = new Date(0).toISOString();
    const materialization = {
      schemaVersion: "octopus.reef.materialization/v1",
      ref: `materialization:${"a".repeat(64)}`,
      runtimeDescriptorDigest: `sha256:${"a".repeat(64)}`,
      authoritativeSourceBundleDigest: digest,
      entryCount: 1,
      totalBytes: 1,
    };
    const run = {
      organisationRef: "organisation:0.3-upgrade",
      projectRef: "project:0.3-upgrade",
      candidateRef: "foundation-candidate:0.3-upgrade",
      candidateDigest: sha("0.3-candidate"),
      sourceBundleRef: `source-bundle:${digest}`,
      sourceBundleDigest: digest,
      verificationProfileRef: "verification-profile:0.3-upgrade",
      verificationProfileVersion: "1.0.0",
      verificationProfileDigest: sha("0.3-profile"),
      runRef: "verification:0.3-upgrade",
      idempotencyKey: "0.3-upgrade",
      state: "failed",
      version: 1,
      attempt: 1,
      eventCursor: "0",
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      checks: [],
      failure: { code: "OLD_RUNTIME", message: "historical", retryable: false },
      materialization,
    };
    try {
      for (const migration of VERIFICATION_MIGRATIONS.slice(0, 2)) {
        await pool.query(migration.sql);
      }
      await pool.query(
        `INSERT INTO verification_runs (
          organisation_ref, project_ref, run_ref, idempotency_key,
          candidate_ref, candidate_digest, source_bundle_ref, source_bundle_digest,
          verification_profile_ref, verification_profile_version, verification_profile_digest,
          state, version, attempt, event_cursor, run_data, created_at, updated_at,
          materialization_schema_version, materialization_ref,
          materialization_descriptor_digest, authoritative_source_bundle_digest,
          materialization_entry_count, materialization_total_bytes
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,
          $19,$20,$21,$22,$23,$24
        )`,
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
          run.eventCursor,
          JSON.stringify(run),
          run.createdAt,
          run.updatedAt,
          materialization.schemaVersion,
          materialization.ref,
          materialization.runtimeDescriptorDigest,
          materialization.authoritativeSourceBundleDigest,
          materialization.entryCount,
          materialization.totalBytes,
        ],
      );
      await store.migrate();
      const preserved = await pool.query<{
        readonly materialization_schema_version: string;
        readonly materialization_ref: string;
        readonly builder_source_bundle_ref: null;
      }>(
        `SELECT materialization_schema_version, materialization_ref,
                builder_source_bundle_ref
         FROM verification_runs
         WHERE organisation_ref=$1 AND project_ref=$2 AND run_ref=$3`,
        [run.organisationRef, run.projectRef, run.runRef],
      );
      assert.deepEqual(preserved.rows, [
        {
          materialization_schema_version: materialization.schemaVersion,
          materialization_ref: materialization.ref,
          builder_source_bundle_ref: null,
        },
      ]);
      await assert.rejects(
        store.get(run, run.runRef),
        /0\.3 materialization contract is incompatible with 0\.4/,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "real PostgreSQL total materialization CHECK rejects every partial and malformed tuple",
  {
    skip:
      databaseUrl === undefined
        ? "REEF_TEST_POSTGRES_URL is not configured"
        : false,
  },
  async (t) => {
    const admin = postgresPool(databaseUrl!);
    const schema = `reef_v041_total_check_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(databaseUrl!);
    isolated.searchParams.set("options", `-csearch_path=${schema}`);
    const pool = postgresPool(isolated.toString());
    const store = new PostgresVerificationStore(pool);
    const allNull = materializationTuple();
    const v1 = materializationTuple({
      materialization_schema_version: "octopus.reef.materialization/v1",
      materialization_ref: `materialization:${"1".repeat(64)}`,
      materialization_descriptor_digest: `sha256:${"2".repeat(64)}`,
      authoritative_source_bundle_digest: `sha256:${"3".repeat(64)}`,
      materialization_entry_count: 1,
      materialization_total_bytes: 0,
    });
    const builderDigest = `sha256:${"4".repeat(64)}`;
    const v2 = materializationTuple({
      materialization_schema_version: "octopus.reef.materialization/v2",
      materialization_ref: `materialization:${"5".repeat(64)}`,
      materialization_descriptor_ref: `materialization-descriptor:${"6".repeat(64)}`,
      materialization_descriptor_digest: `sha256:${"7".repeat(64)}`,
      authoritative_source_bundle_digest: builderDigest,
      builder_source_bundle_ref: `source-bundle:${builderDigest}`,
      builder_source_bundle_digest: builderDigest,
      builder_source_bundle_binding_ref: `builder-source-bundle-binding:${"8".repeat(64)}`,
      builder_source_bundle_binding_digest: `sha256:${"9".repeat(64)}`,
      materialization_entry_count: 2,
      materialization_total_bytes: 3,
    });
    try {
      for (const migration of VERIFICATION_MIGRATIONS.slice(0, 3)) {
        await pool.query(migration.sql);
      }
      await insertConstraintFixture(pool, "all-null");
      await insertConstraintFixture(pool, "complete-v1");
      await insertConstraintFixture(pool, "complete-v2");
      await insertConstraintFixture(pool, "invalid-partial");
      await updateMaterialization(pool, "complete-v1", v1);
      await updateMaterialization(pool, "complete-v2", v2);
      await updateMaterialization(
        pool,
        "invalid-partial",
        materializationTuple({
          materialization_ref: v2.materialization_ref,
        }),
      );
      await assert.rejects(store.ready(), /readiness failed/);

      await assertMaterializationConstraintViolation(
        pool.query(VERIFICATION_MIGRATIONS[3]!.sql),
        "0.4 partial row blocks migration",
        /0004_materialization_identity_total_check aborted: 1 row\(s\) have a partial or invalid materialization identity/,
      );
      assert.doesNotMatch(
        await materializationConstraintDefinition(pool),
        /num_nonnulls/,
      );
      t.diagnostic(
        "0004 pre-scan rejected one 0.4 partial row with SQLSTATE 23514 and preserved the prior constraint",
      );
      await updateMaterialization(pool, "invalid-partial", allNull);
      await pool.query(VERIFICATION_MIGRATIONS[3]!.sql);
      await store.ready();
      const totalConstraint = await materializationConstraintDefinition(pool);
      assert.match(totalConstraint, /num_nonnulls/);
      assert.match(totalConstraint, /CASE/);
      assert.match(totalConstraint, /IS TRUE/i);
      t.diagnostic(
        "database constraint introspection confirms CASE + num_nonnulls + IS TRUE",
      );

      const v1PresenceValues = materializationTuple({
        ...v2,
        materialization_schema_version: v1.materialization_schema_version,
        materialization_ref: v1.materialization_ref,
        materialization_descriptor_digest: v1.materialization_descriptor_digest,
        authoritative_source_bundle_digest: builderDigest,
      });
      const v1CompleteMask = materializationPresenceMask([
        "materialization_schema_version",
        "materialization_ref",
        "materialization_descriptor_digest",
        "authoritative_source_bundle_digest",
        "materialization_entry_count",
        "materialization_total_bytes",
      ]);
      let rejectedV1PresenceMasks = 0;
      for (let mask = 0; mask < 1 << materializationColumns.length; mask += 1) {
        const tuple = materializationTupleForPresenceMask(
          v1PresenceValues,
          mask,
        );
        if (mask === 0 || mask === v1CompleteMask) {
          await updateMaterialization(pool, "all-null", tuple);
        } else {
          await assertMaterializationConstraintViolation(
            updateMaterialization(pool, "all-null", tuple),
            `v1 presence mask ${mask.toString(2).padStart(11, "0")}`,
          );
          rejectedV1PresenceMasks += 1;
        }
      }
      assert.equal(rejectedV1PresenceMasks, 2046);
      t.diagnostic(
        `v1 exhaustive presence masks rejected=${rejectedV1PresenceMasks} accepted=2`,
      );

      const v2CompleteMask = (1 << materializationColumns.length) - 1;
      let rejectedV2PresenceMasks = 0;
      for (let mask = 0; mask <= v2CompleteMask; mask += 1) {
        const tuple = materializationTupleForPresenceMask(v2, mask);
        if (mask === 0 || mask === v2CompleteMask) {
          await updateMaterialization(pool, "complete-v2", tuple);
        } else {
          await assertMaterializationConstraintViolation(
            updateMaterialization(pool, "complete-v2", tuple),
            `v2 presence mask ${mask.toString(2).padStart(11, "0")}`,
          );
          rejectedV2PresenceMasks += 1;
        }
      }
      assert.equal(rejectedV2PresenceMasks, 2046);
      t.diagnostic(
        `v2 exhaustive presence masks rejected=${rejectedV2PresenceMasks} accepted=2`,
      );

      for (const column of materializationColumns) {
        await assertMaterializationConstraintViolation(
          updateMaterialization(
            pool,
            "all-null",
            materializationTuple({
              [column]: v2[column],
            }),
          ),
          `only ${column}`,
        );
      }
      await updateMaterialization(pool, "all-null", allNull);

      const v1Required = [
        "materialization_schema_version",
        "materialization_ref",
        "materialization_descriptor_digest",
        "authoritative_source_bundle_digest",
        "materialization_entry_count",
        "materialization_total_bytes",
      ] as const;
      for (const column of v1Required) {
        await assertMaterializationConstraintViolation(
          updateMaterialization(
            pool,
            "complete-v1",
            materializationTuple({ ...v1, [column]: null }),
          ),
          `v1 missing ${column}`,
        );
      }
      for (const [label, tuple] of [
        [
          "v1 malformed schema",
          materializationTuple({
            ...v1,
            materialization_schema_version: "octopus.reef.materialization/v0",
          }),
        ],
        [
          "v1 malformed ref",
          materializationTuple({
            ...v1,
            materialization_ref: "materialization:01",
          }),
        ],
        [
          "v1 malformed descriptor digest",
          materializationTuple({
            ...v1,
            materialization_descriptor_digest: "sha256:01",
          }),
        ],
        [
          "v1 malformed authoritative digest",
          materializationTuple({
            ...v1,
            authoritative_source_bundle_digest: "sha256:01",
          }),
        ],
        [
          "v1 zero entries",
          materializationTuple({ ...v1, materialization_entry_count: 0 }),
        ],
        [
          "v1 negative bytes",
          materializationTuple({ ...v1, materialization_total_bytes: -1 }),
        ],
        [
          "v1 mixed with v2-only field",
          materializationTuple({
            ...v1,
            materialization_descriptor_ref: v2.materialization_descriptor_ref,
          }),
        ],
      ] as const) {
        await assertMaterializationConstraintViolation(
          updateMaterialization(pool, "complete-v1", tuple),
          label,
        );
      }

      for (const column of materializationColumns) {
        await assertMaterializationConstraintViolation(
          updateMaterialization(
            pool,
            "complete-v2",
            materializationTuple({ ...v2, [column]: null }),
          ),
          `v2 missing ${column}`,
        );
      }
      for (const [label, tuple] of [
        [
          "v2 malformed schema",
          materializationTuple({
            ...v2,
            materialization_schema_version: "octopus.reef.materialization/v3",
          }),
        ],
        [
          "v2 malformed ref",
          materializationTuple({
            ...v2,
            materialization_ref: "materialization:01",
          }),
        ],
        [
          "v2 malformed descriptor ref",
          materializationTuple({
            ...v2,
            materialization_descriptor_ref: "materialization-descriptor:01",
          }),
        ],
        [
          "v2 malformed descriptor digest",
          materializationTuple({
            ...v2,
            materialization_descriptor_digest: "sha256:01",
          }),
        ],
        [
          "v2 malformed source bundle ref",
          materializationTuple({
            ...v2,
            builder_source_bundle_ref: "source-bundle:sha256:01",
          }),
        ],
        [
          "v2 malformed source bundle digest",
          materializationTuple({
            ...v2,
            authoritative_source_bundle_digest: "sha256:01",
            builder_source_bundle_digest: "sha256:01",
          }),
        ],
        [
          "v2 source bundle digest mismatch",
          materializationTuple({
            ...v2,
            authoritative_source_bundle_digest: `sha256:${"a".repeat(64)}`,
          }),
        ],
        [
          "v2 malformed binding ref",
          materializationTuple({
            ...v2,
            builder_source_bundle_binding_ref:
              "builder-source-bundle-binding:01",
          }),
        ],
        [
          "v2 malformed binding digest",
          materializationTuple({
            ...v2,
            builder_source_bundle_binding_digest: "sha256:01",
          }),
        ],
        [
          "v2 zero entries",
          materializationTuple({ ...v2, materialization_entry_count: 0 }),
        ],
        [
          "v2 negative bytes",
          materializationTuple({ ...v2, materialization_total_bytes: -1 }),
        ],
      ] as const) {
        await assertMaterializationConstraintViolation(
          updateMaterialization(pool, "complete-v2", tuple),
          label,
        );
      }
      t.diagnostic(
        "explicit only-one, missing-field, malformed complete, digest mismatch, and numeric-bound cases all failed with SQLSTATE 23514",
      );

      await updateMaterialization(pool, "all-null", allNull);
      await updateMaterialization(pool, "complete-v1", v1);
      await updateMaterialization(pool, "complete-v2", v2);
      await pool.query(VERIFICATION_MIGRATIONS[3]!.sql);

      const restartedPool = postgresPool(isolated.toString());
      const restartedStore = new PostgresVerificationStore(restartedPool);
      try {
        await restartedStore.ready();
        const rows = await restartedPool.query<{
          readonly run_ref: string;
          readonly materialization_schema_version: string | null;
        }>(
          `SELECT run_ref, materialization_schema_version
           FROM verification_runs
           WHERE run_ref IN ('verification:all-null', 'verification:complete-v1', 'verification:complete-v2')
           ORDER BY run_ref`,
        );
        assert.deepEqual(rows.rows, [
          {
            run_ref: "verification:all-null",
            materialization_schema_version: null,
          },
          {
            run_ref: "verification:complete-v1",
            materialization_schema_version: "octopus.reef.materialization/v1",
          },
          {
            run_ref: "verification:complete-v2",
            materialization_schema_version: "octopus.reef.materialization/v2",
          },
        ]);
        t.diagnostic(
          "all-null, complete v1, and complete v2 controls survived repeated migration and a new connection restart",
        );
      } finally {
        await restartedPool.end();
      }
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "real PostgreSQL serializes concurrent migration entrypoints",
  {
    skip:
      databaseUrl === undefined
        ? "REEF_TEST_POSTGRES_URL is not configured"
        : false,
  },
  async () => {
    const api = new PostgresVerificationStore(databaseUrl!);
    const worker = new PostgresVerificationStore(databaseUrl!);
    try {
      await Promise.all([api.migrate(), worker.migrate()]);
      await Promise.all([api.ready(), worker.ready()]);
    } finally {
      await Promise.all([api.close(), worker.close()]);
    }
  },
);

test(
  "real PostgreSQL migration, restart recovery, duplicate delivery, fencing, and tenant isolation",
  {
    skip:
      databaseUrl === undefined
        ? "REEF_TEST_POSTGRES_URL is not configured"
        : false,
  },
  async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = (): string => new Date(now).toISOString();
    const profile = defineTrustedProfile({
      ref: "verification-profile:postgres",
      version: "1.0.0",
      sandboxImageDigest: sha("sandbox"),
      maxDurationMs: 60_000,
      maxChecks: 2,
      checks: [
        check("first", [
          "node",
          "-e",
          "require('fs').writeFileSync('first','ok')",
        ]),
        check("second", [
          "node",
          "-e",
          "require('fs').writeFileSync('second','ok')",
        ]),
      ],
    });
    const profiles = new StaticVerificationProfileRegistry([profile]);
    const root = mkdtempSync(join(tmpdir(), "reef-verification-pg-"));
    const sourceRoot = join(root, "source");
    const tenant = {
      organisationRef: "organisation:pg",
      projectRef: "project:pg",
    };
    const descriptor = writeBundle(sourceRoot, tenant);
    const evidence = new LocalVerificationEvidenceStore(join(root, "evidence"));
    const artifacts = new LocalVerificationArtifactStore(
      join(root, "artifacts"),
    );
    const sandbox = new LocalVerificationSandboxProvisioner(
      join(root, "workspaces"),
    );

    let store = new PostgresVerificationStore(databaseUrl!, { now: clock });
    await store.migrate();
    await store.ready();
    const service = new VerificationService({
      store,
      evidence,
      profiles,
      now: clock,
      id: () => "verification:pg-restart",
    });
    const run = await service.createRun(
      tenant,
      request(tenant, descriptor, profile, "create-pg"),
    );
    await new VerificationDispatchPublisher({
      ownerId: "publisher",
      store,
      queue: store,
      now: clock,
    }).drainOnce();
    let crash = true;
    const firstWorker = makeWorker(
      store,
      "old-worker",
      profiles,
      sourceRoot,
      evidence,
      artifacts,
      sandbox,
      clock,
      () => {
        if (crash) {
          crash = false;
          throw new VerificationWorkerProcessCrash();
        }
      },
    );
    await assert.rejects(firstWorker.runOnce(), VerificationWorkerProcessCrash);
    assert.deepEqual(
      (await store.get(tenant, run.runRef))?.checks.map(
        (item) => item.checkRef,
      ),
      ["first"],
    );
    const interruptedMaterialization = (await store.get(tenant, run.runRef))
      ?.materialization;
    assert.ok(interruptedMaterialization);
    await store.close();

    now += 31_000;
    store = new PostgresVerificationStore(databaseUrl!, { now: clock });
    const resumed = makeWorker(
      store,
      "new-worker",
      profiles,
      sourceRoot,
      evidence,
      artifacts,
      sandbox,
      clock,
    );
    assert.equal(await resumed.runOnce(), true);
    const completed = await store.get(tenant, run.runRef);
    assert.equal(completed?.state, "completed");
    assert.deepEqual(completed?.materialization, interruptedMaterialization);
    assert.deepEqual(
      completed?.checks.map((item) => item.checkRef),
      ["first", "second"],
    );
    assert.equal((await store.checkpoints(tenant, run.runRef)).length, 2);
    assert.equal(
      (await store.events(tenant, run.runRef, "0")).filter(
        (event) => event.type === "verification.materialized",
      ).length,
      1,
    );

    await store.enqueue(tenant, run.runRef, run.attempt);
    assert.equal(await resumed.runOnce(), true);
    assert.equal((await store.checkpoints(tenant, run.runRef)).length, 2);

    const otherTenant = {
      organisationRef: "organisation:other",
      projectRef: tenant.projectRef,
    };
    assert.equal(await store.get(otherTenant, run.runRef), undefined);
    const otherService = new VerificationService({
      store,
      evidence,
      profiles,
      now: clock,
      id: () => run.runRef,
    });
    const otherRun = await otherService.createRun(
      otherTenant,
      request(
        otherTenant,
        writeBundle(sourceRoot, otherTenant),
        profile,
        "create-pg",
      ),
    );
    assert.equal(otherRun.runRef, run.runRef);
    assert.equal((await store.events(otherTenant, run.runRef)).length, 1);
    assert.ok(BigInt(otherRun.eventCursor) > BigInt(completed!.eventCursor));
    await store.close();
  },
);

test(
  "real PostgreSQL preserves a cursor above Number.MAX_SAFE_INTEGER across restart",
  {
    skip:
      databaseUrl === undefined
        ? "REEF_TEST_POSTGRES_URL is not configured"
        : false,
  },
  async () => {
    const tenant = {
      organisationRef: "organisation:pg-large-cursor",
      projectRef: "project:pg-large-cursor",
    };
    const profile = defineTrustedProfile({
      ref: "verification-profile:pg-large-cursor",
      version: "1.0.0",
      sandboxImageDigest: sha("large-cursor-sandbox"),
      maxDurationMs: 60_000,
      maxChecks: 1,
      checks: [check("large-cursor", ["true"])],
    });
    const id = `verification:pg-large-cursor-${process.pid}-${Date.now()}`;
    const key = `pg-large-cursor-${process.pid}-${Date.now()}`;

    const firstPool = postgresPool(databaseUrl!);
    const firstStore = new PostgresVerificationStore(firstPool);
    await firstStore.migrate();
    await firstPool.query(
      `SELECT setval(
        'verification_events_cursor_seq',
        GREATEST(
          (SELECT last_value FROM verification_events_cursor_seq),
          9007199254740993::bigint
        ),
        true
      )`,
    );
    const firstService = new VerificationService({
      store: firstStore,
      evidence: new MemoryEvidenceStore(),
      profiles: new StaticVerificationProfileRegistry([profile]),
      id: () => id,
    });
    const created = await firstService.createRun(tenant, {
      ...tenant,
      candidateRef: "foundation-candidate:pg-large-cursor",
      candidateDigest: sha("large-cursor-candidate"),
      sourceBundleRef: "source-bundle:pg-large-cursor",
      sourceBundleDigest: sha("large-cursor-source"),
      verificationProfileRef: profile.ref,
      verificationProfileVersion: profile.version,
      verificationProfileDigest: profile.digest,
      idempotencyKey: key,
    });
    assert.ok(
      BigInt(created.eventCursor) > BigInt(Number.MAX_SAFE_INTEGER),
      created.eventCursor,
    );
    await firstPool.end();

    const secondPool = postgresPool(databaseUrl!);
    const secondStore = new PostgresVerificationStore(secondPool);
    try {
      const restarted = await secondStore.get(tenant, created.runRef);
      assert.equal(restarted?.eventCursor, created.eventCursor);
      const events = await secondStore.events(tenant, created.runRef, "0");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.cursor, created.eventCursor);
      for (const cursor of [
        "01",
        "+1",
        "-0",
        "",
        "1e3",
        "1.0",
        " 1",
        "1 ",
        "١",
        "１",
      ]) {
        await assert.rejects(
          secondStore.events(tenant, created.runRef, cursor),
          /canonical non-negative ASCII decimal/,
        );
      }
    } finally {
      await secondPool.end();
    }
  },
);

function makeWorker(
  store: PostgresVerificationStore,
  workerId: string,
  profiles: StaticVerificationProfileRegistry,
  sourceRoot: string,
  evidence: LocalVerificationEvidenceStore,
  artifacts: LocalVerificationArtifactStore,
  sandbox: LocalVerificationSandboxProvisioner,
  now: () => string,
  afterCheckpoint?: () => void,
): DeterministicVerificationWorker {
  return new DeterministicVerificationWorker({
    workerId,
    store,
    queue: store,
    profiles,
    materializer: new DeterministicSourceBundleMaterializer({
      store: new LocalSourceBundleStore(sourceRoot),
    }),
    sandboxes: sandbox,
    evidence,
    artifacts,
    secrets: new EnvironmentProfileSecretResolver({}),
    leaseMs: 30_000,
    now,
    ...(afterCheckpoint === undefined ? {} : { afterCheckpoint }),
  });
}

function writeBundle(
  root: string,
  tenant: { organisationRef: string; projectRef: string },
): SourceBundleDescriptor {
  mkdirSync(root, { recursive: true });
  const content = Buffer.from("export const postgresFixture = true;\n");
  const entry = {
    path: "fixture.js",
    sizeBytes: content.byteLength,
    contentDigest: shaBytes(content),
  };
  const bundleDigest = computeBuilderSourceBundleDigest([entry]);
  const descriptor: SourceBundleDescriptor = {
    schemaVersion: "octopus.builder.source-bundle/v1" as const,
    ...tenant,
    bundleRef: `source-bundle:${bundleDigest}`,
    digest: bundleDigest,
    inventory: [entry],
  };
  const tenantDirectory = hash(
    `${tenant.organisationRef}\0${tenant.projectRef}`,
  ).slice(0, 32);
  const descriptorPath = join(
    root,
    tenantDirectory,
    "bundles",
    hash(descriptor.bundleRef),
    "descriptor.json",
  );
  const objectPath = join(
    root,
    tenantDirectory,
    "objects",
    hash(`${descriptor.bundleRef}\0${entry.path}`),
  );
  mkdirSync(dirname(descriptorPath), { recursive: true });
  mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify(descriptor));
  writeFileSync(objectPath, content);
  return descriptor;
}

function request(
  tenant: { organisationRef: string; projectRef: string },
  descriptor: SourceBundleDescriptor,
  profile: ReturnType<typeof defineTrustedProfile>,
  idempotencyKey: string,
): VerificationRunRequest {
  return {
    ...tenant,
    candidateRef: "foundation-candidate:pg",
    candidateDigest: sha("candidate"),
    sourceBundleRef: descriptor.bundleRef,
    sourceBundleDigest: descriptor.digest,
    verificationProfileRef: profile.ref,
    verificationProfileVersion: profile.version,
    verificationProfileDigest: profile.digest,
    idempotencyKey,
  };
}

function check(checkRef: string, argv: readonly string[]) {
  return {
    checkRef,
    required: true,
    argv,
    workingDirectory: ".",
    timeoutMs: 5000,
    outputLimitBytes: 4096,
    environment: {},
    tool: { name: "node", version: process.version, imageDigest: sha("tool") },
  } as const;
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function sha(value: string): string {
  return `sha256:${hash(value)}`;
}
function shaBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function postgresPool(
  connectionString: string,
): VerificationPgPoolLike & { end(): Promise<void> } {
  const { Pool } = createRequire(import.meta.url)("pg") as {
    readonly Pool: new (options: {
      readonly connectionString: string;
    }) => VerificationPgPoolLike & { end(): Promise<void> };
  };
  return new Pool({ connectionString });
}

function materializationTuple(
  values: Partial<MaterializationTuple> = {},
): MaterializationTuple {
  return Object.fromEntries(
    materializationColumns.map((column) => [column, values[column] ?? null]),
  ) as unknown as MaterializationTuple;
}

async function insertConstraintFixture(
  pool: VerificationPgPoolLike,
  suffix: string,
): Promise<void> {
  const digest = `sha256:${"a".repeat(64)}`;
  await pool.query(
    `INSERT INTO verification_runs (
      organisation_ref, project_ref, run_ref, idempotency_key,
      candidate_ref, candidate_digest, source_bundle_ref, source_bundle_digest,
      verification_profile_ref, verification_profile_version, verification_profile_digest,
      state, version, attempt, event_cursor, run_data, created_at, updated_at
    ) VALUES (
      'organisation:constraint', 'project:constraint', $1, $2,
      'foundation-candidate:constraint', $3, 'source-bundle:constraint', $3,
      'verification-profile:constraint', '1.0.0', $3,
      'queued', 1, 1, 0, '{}'::jsonb, now(), now()
    )`,
    [`verification:${suffix}`, `constraint:${suffix}`, digest],
  );
}

function updateMaterialization(
  pool: VerificationPgPoolLike,
  suffix: string,
  tuple: MaterializationTuple,
): Promise<unknown> {
  return pool.query(
    `UPDATE verification_runs SET
      materialization_schema_version=$1,
      materialization_ref=$2,
      materialization_descriptor_ref=$3,
      materialization_descriptor_digest=$4,
      authoritative_source_bundle_digest=$5,
      builder_source_bundle_ref=$6,
      builder_source_bundle_digest=$7,
      builder_source_bundle_binding_ref=$8,
      builder_source_bundle_binding_digest=$9,
      materialization_entry_count=$10,
      materialization_total_bytes=$11
    WHERE organisation_ref='organisation:constraint'
      AND project_ref='project:constraint'
      AND run_ref=$12`,
    [
      ...materializationColumns.map((column) => tuple[column]),
      `verification:${suffix}`,
    ],
  );
}

async function assertMaterializationConstraintViolation(
  operation: Promise<unknown>,
  label: string,
  expectedMessage?: RegExp,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal(
        (error as { readonly code?: string }).code,
        "23514",
        `${label} must fail with check_violation`,
      );
      if (expectedMessage !== undefined) {
        assert.match(
          String((error as { readonly message?: unknown }).message),
          expectedMessage,
          `${label} must provide the fail-closed migration diagnostic`,
        );
      }
      return true;
    },
    label,
  );
}

function materializationTupleForPresenceMask(
  values: MaterializationTuple,
  mask: number,
): MaterializationTuple {
  return materializationTuple(
    Object.fromEntries(
      materializationColumns.map((column, index) => [
        column,
        (mask & (1 << index)) === 0 ? null : values[column],
      ]),
    ) as Partial<MaterializationTuple>,
  );
}

function materializationPresenceMask(
  present: readonly MaterializationColumn[],
): number {
  return present.reduce((mask, column) => {
    const index = materializationColumns.indexOf(column);
    assert.notEqual(index, -1);
    return mask | (1 << index);
  }, 0);
}

async function materializationConstraintDefinition(
  pool: VerificationPgPoolLike,
): Promise<string> {
  const result = await pool.query<{ readonly definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid='verification_runs'::regclass
       AND conname='verification_runs_materialization_identity_check'`,
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.definition;
}
