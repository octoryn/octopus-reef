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
