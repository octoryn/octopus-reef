import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvidence } from "octopus-evidence";
import {
  DeterministicSourceBundleMaterializer,
  DeterministicVerificationWorker,
  MemoryArtifactStore,
  MemoryEvidenceStore,
  MemorySourceBundleStore,
  MemoryVerificationQueue,
  MemoryVerificationStore,
  StaticVerificationProfileRegistry,
  VerificationDispatchPublisher,
  VerificationService,
  VerificationWorkerProcessCrash,
  computeBuilderSourceBundleDigest,
  defineTrustedProfile,
  type SourceBundleDescriptor,
  type TrustedVerificationProfile,
  type VerificationMaterialization,
  type VerificationRunRequest,
  type VerificationSandbox,
  type VerificationSandboxProvisioner,
  type VerificationTenant,
} from "../src/index.js";
import {
  EnvironmentProfileSecretResolver,
  LocalVerificationSandboxProvisioner,
} from "../src/adapters/local.js";

const tenant: VerificationTenant = {
  organisationRef: "organisation:acme",
  projectRef: "project:reef",
};
const imageDigest = sha(Buffer.from("verification-image"));

test("crash after a durable check checkpoint resumes without executing it twice", async () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = (): string => new Date(now).toISOString();
  const profile = makeProfile([
    check(
      "first",
      ["node", "-e", "require('fs').appendFileSync('first-count','x')"],
      [
        {
          path: "first-count",
          kind: "test-ref",
          mediaType: "text/plain",
          required: true,
          maxBytes: 10,
        },
      ],
    ),
    check("second", [
      "node",
      "-e",
      "require('fs').writeFileSync('second-ok','ok')",
    ]),
  ]);
  const setup = await fixture(profile, clock);
  let crash = true;
  const firstWorker = worker(setup, "worker-a", {
    now: clock,
    afterCheckpoint: () => {
      if (crash) {
        crash = false;
        throw new VerificationWorkerProcessCrash();
      }
    },
  });
  await assert.rejects(firstWorker.runOnce(), VerificationWorkerProcessCrash);
  const interrupted = await setup.store.get(tenant, setup.run.runRef);
  assert.ok(interrupted?.materialization);
  const firstMaterialization = interrupted.materialization;
  assert.deepEqual(
    interrupted?.checks.map((result) => result.checkRef),
    ["first"],
  );

  now += 31_000;
  const secondWorker = worker(setup, "worker-b", { now: clock });
  assert.equal(await secondWorker.runOnce(), true);
  const completed = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.verdict?.outcome, "passed");
  assert.deepEqual(completed?.materialization, firstMaterialization);
  assert.deepEqual(
    completed?.checks.map((result) => result.checkRef),
    ["first", "second"],
  );
  assert.equal(
    (await setup.store.checkpoints(tenant, setup.run.runRef)).length,
    2,
  );
  assert.equal(
    (await setup.store.events(tenant, setup.run.runRef, "0")).filter(
      (event) => event.type === "verification.materialized",
    ).length,
    1,
  );
});

test("infrastructure retry fences the prior attempt materialization descriptor", async () => {
  const setup = await fixture(
    makeProfile([check("tests", ["node", "-e", "process.exit(0)"])]),
  );
  let failOnce = true;
  const wrap = (target: VerificationSandbox): VerificationSandbox => ({
    id: target.id,
    workspacePath: target.workspacePath,
    writeFile: (path, value, signal) => target.writeFile(path, value, signal),
    removeFiles: (paths, signal) => target.removeFiles(paths, signal),
    execute: (definition, environment, signal) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated sandbox infrastructure failure");
      }
      return target.execute(definition, environment, signal);
    },
    readFile: (path, maxBytes, signal) =>
      target.readFile(path, maxBytes, signal),
  });
  const flakySandboxes: VerificationSandboxProvisioner = {
    provision: async (spec, signal) =>
      wrap(await setup.sandbox.provision(spec, signal)),
    restore: async (spec, ref, signal) => {
      const restored = await setup.sandbox.restore?.(spec, ref, signal);
      return restored === undefined ? undefined : wrap(restored);
    },
    destroy: (target) => setup.sandbox.destroy(target),
  };
  const process = worker(setup, "worker-materialization-retry", {
    retryBaseMs: 0,
    sandboxes: flakySandboxes,
  });
  assert.equal(await process.runOnce(), true);
  const retried = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(retried?.state, "queued");
  assert.equal(retried?.attempt, 2);
  assert.equal(retried?.materialization, undefined);

  assert.equal(await process.runOnce(), true);
  const completed = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.attempt, 2);
  assert.ok(completed?.materialization);
  const materializedEvents = (
    await setup.store.events(tenant, setup.run.runRef, "0")
  ).filter((event) => event.type === "verification.materialized");
  assert.equal(materializedEvents.length, 2);
  const digests = materializedEvents.map(
    (event) =>
      (
        event.data as {
          materialization: VerificationMaterialization;
        }
      ).materialization.runtimeDescriptorDigest,
  );
  assert.notEqual(digests[0], digests[1]);
});

test("duplicate queue delivery is acknowledged without duplicate check execution", async () => {
  const profile = makeProfile([
    check("tests", ["node", "-e", "process.exit(0)"]),
  ]);
  const setup = await fixture(profile, undefined, true);
  const process = worker(setup, "worker-duplicate");
  assert.equal(await process.runOnce(), true);
  assert.equal(await process.runOnce(), true);
  const run = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(run?.state, "completed");
  assert.equal(run?.checks.length, 1);
  assert.equal(
    (await setup.store.checkpoints(tenant, setup.run.runRef)).length,
    1,
  );
});

test("idempotency binds the exact tenant, candidate, source, and profile tuple", async () => {
  const setup = await fixture(
    makeProfile([check("tests", ["node", "-e", "process.exit(0)"])]),
  );
  const request: VerificationRunRequest = {
    organisationRef: setup.run.organisationRef,
    projectRef: setup.run.projectRef,
    candidateRef: setup.run.candidateRef,
    candidateDigest: setup.run.candidateDigest,
    sourceBundleRef: setup.run.sourceBundleRef,
    sourceBundleDigest: setup.run.sourceBundleDigest,
    verificationProfileRef: setup.run.verificationProfileRef,
    verificationProfileVersion: setup.run.verificationProfileVersion,
    verificationProfileDigest: setup.run.verificationProfileDigest,
    idempotencyKey: setup.run.idempotencyKey,
  };
  assert.equal(
    (await setup.service.createRun(tenant, request)).runRef,
    setup.run.runRef,
  );
  await assert.rejects(
    setup.service.createRun(tenant, {
      ...request,
      candidateDigest: sha(Buffer.from("other")),
    }),
    /idempotency key conflicts/,
  );
});

test("expired lease is fenced and can be taken over safely", async () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = (): string => new Date(now).toISOString();
  const setup = await fixture(
    makeProfile([check("tests", ["node", "-e", "process.exit(0)"])]),
    clock,
  );
  const first = await setup.store.acquireLease(
    tenant,
    setup.run.runRef,
    "old",
    1000,
    clock(),
  );
  assert.ok(first?.lease);
  now += 1001;
  const second = await setup.store.acquireLease(
    tenant,
    setup.run.runRef,
    "new",
    1000,
    clock(),
  );
  assert.ok(second?.lease);
  assert.notEqual(second?.lease?.fencingToken, first?.lease?.fencingToken);
  assert.equal(
    await setup.store.assertFence(
      tenant,
      setup.run.runRef,
      first!.lease!.fencingToken,
    ),
    false,
  );
  assert.equal(
    await setup.store.assertFence(
      tenant,
      setup.run.runRef,
      second!.lease!.fencingToken,
    ),
    true,
  );
});

test("cancellation observed through fencing aborts the active child process", async () => {
  const setup = await fixture(
    makeProfile([
      check("long-running", ["node", "-e", "setTimeout(() => {}, 3000)"]),
    ]),
  );
  const active = worker(setup, "worker-cancel", { leaseMs: 150 });
  const started = Date.now();
  const running = active.runOnce();
  await waitFor(
    async () =>
      (await setup.store.get(tenant, setup.run.runRef))?.state === "running",
  );
  await setup.service.cancelRun(tenant, setup.run.runRef, {
    idempotencyKey: "cancel-active",
  });
  await running;
  assert.ok(
    Date.now() - started < 1500,
    "cancelled child was not terminated promptly",
  );
  assert.equal(
    (await setup.store.get(tenant, setup.run.runRef))?.state,
    "cancelled",
  );
});

test("a failed required test is completed with failed verdict, not operational failed", async () => {
  const setup = await fixture(
    makeProfile([check("tests", ["node", "-e", "process.exit(7)"])]),
  );
  await worker(setup, "worker-failing-test").runOnce();
  const run = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(run?.state, "completed");
  assert.equal(run?.verdict?.outcome, "failed");
  assert.equal(run?.failure, undefined);
  assert.equal(run?.checks[0]?.exitCode, 7);
  assert.ok(run?.verdict);
  const verdictEnvelope = await setup.service.resolveEvidence(
    tenant,
    run.verdict.evidenceRef,
  );
  assert.ok(verdictEnvelope?.verifier.integrityVerified);
  assert.deepEqual(verdictEnvelope?.materialization, run.materialization);
  const verdictContent = verdictEnvelope?.evidence.content as Record<
    string,
    unknown
  >;
  assert.equal(verdictContent["runVersion"], run.version);
  assert.equal(verdictContent["attempt"], run.attempt);
  assert.deepEqual(
    (verdictContent["identity"] as Record<string, unknown>)["candidateDigest"],
    run.candidateDigest,
  );

  const checkEnvelope = await setup.service.resolveEvidence(
    tenant,
    run.checks[0]!.evidenceRef,
  );
  assert.deepEqual(checkEnvelope?.materialization, run.materialization);
  assert.equal(
    (checkEnvelope?.evidence.content as Record<string, unknown>)["runVersion"],
    run.version - 1,
  );
});

test("profile duration exhaustion is an operational failure", async () => {
  const profile = makeProfile(
    [
      check("first", ["node", "-e", "setTimeout(()=>{},20)"]),
      check("second", ["node", "-e", "process.exit(0)"]),
    ],
    1,
  );
  const setup = await fixture(profile);
  await worker(setup, "worker-budget", {
    maxInfrastructureRetries: 0,
  }).runOnce();
  const run = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(run?.state, "failed");
  assert.equal(run?.failure?.code, "PROFILE_BUDGET_EXCEEDED");
  assert.equal(run?.verdict, undefined);
});

test("trusted profiles reject unknown fields and process-injection environment names", () => {
  const base = {
    ref: "verification-profile:strict",
    version: "1.0.0",
    sandboxImageDigest: imageDigest,
    maxDurationMs: 1000,
    maxChecks: 1,
    checks: [check("strict", ["node", "--version"])],
  };
  assert.throws(
    () => defineTrustedProfile({ ...base, mutableAlias: "latest" } as never),
    /missing or unsupported fields/,
  );
  assert.throws(
    () =>
      defineTrustedProfile({
        ...base,
        checks: [
          {
            ...base.checks[0]!,
            environment: { NODE_OPTIONS: "--require=/tmp/payload" },
          },
        ],
      }),
    /unsafe profile environment name/,
  );
  assert.throws(
    () =>
      defineTrustedProfile({
        ...base,
        checks: [
          {
            ...base.checks[0]!,
            secretBindings: [
              {
                name: "payload",
                secretRef: "secret:payload",
                environmentName: "LD_PRELOAD",
              },
            ],
          },
        ],
      }),
    /unsafe secret binding/,
  );
});

test("tenant isolation applies to runs, artifacts, and Evidence", async () => {
  const setup = await fixture(
    makeProfile([check("tests", ["node", "-e", "process.exit(0)"])]),
  );
  await worker(setup, "worker-isolation").runOnce();
  const other = {
    organisationRef: "organisation:other",
    projectRef: tenant.projectRef,
  };
  assert.equal(await setup.store.get(other, setup.run.runRef), undefined);
  const evidenceRef = (await setup.store.get(tenant, setup.run.runRef))!
    .verdict!.evidenceRef;
  assert.equal(await setup.evidence.get(other, evidenceRef), undefined);
  await assert.rejects(
    setup.service.getRun(other, setup.run.runRef),
    /not found/,
  );
});

test("Evidence resolution distrusts stored digest and integrity metadata", async () => {
  const evidence = createEvidence({
    kind: "deterministic-verification-check",
    subject: [{ type: "verification-run", id: "verification:corrupt" }],
    actor: { type: "verification-profile", id: "verification-profile:corrupt" },
    content: { outcome: "passed" },
    provenance: {
      source: "octopus-reef-verification",
      method: "trusted-profile-check",
      at: "2026-01-01T00:00:00.000Z",
    },
  });
  const service = new VerificationService({
    store: new MemoryVerificationStore(),
    profiles: new StaticVerificationProfileRegistry([]),
    evidence: {
      put: async () => ({
        ref: `evidence:${evidence.id}`,
        digest: sha(Buffer.from("wrong")),
      }),
      get: async () => ({
        ref: `evidence:${evidence.id}`,
        evidence,
        digest: sha(Buffer.from("wrong")),
      }),
    },
  });
  await assert.rejects(
    service.resolveEvidence(tenant, `evidence:${evidence.id}`),
    /digest mismatch/,
  );
});

async function fixture(
  profile: TrustedVerificationProfile,
  now?: () => string,
  duplicates = false,
) {
  const store = new MemoryVerificationStore(now);
  const queue = new MemoryVerificationQueue(now, duplicates);
  const evidence = new MemoryEvidenceStore();
  const artifacts = new MemoryArtifactStore();
  const source = new MemorySourceBundleStore();
  const profiles = new StaticVerificationProfileRegistry([profile]);
  const service = new VerificationService({
    store,
    evidence,
    profiles,
    ...(now === undefined ? {} : { now }),
  });
  const content = Buffer.from("export const fixture = true;\n");
  const entry = {
    path: "fixture.js",
    sizeBytes: content.byteLength,
    contentDigest: sha(content),
  };
  const bundleDigest = computeBuilderSourceBundleDigest([entry]);
  const descriptor: SourceBundleDescriptor = {
    schemaVersion: "octopus.builder.source-bundle/v1" as const,
    ...tenant,
    bundleRef: `source-bundle:${bundleDigest}`,
    digest: bundleDigest,
    inventory: [entry],
  };
  source.add(descriptor, { [entry.path]: content });
  const request: VerificationRunRequest = {
    ...tenant,
    candidateRef: "foundation-candidate:fixture",
    candidateDigest: sha(Buffer.from("candidate")),
    sourceBundleRef: descriptor.bundleRef,
    sourceBundleDigest: descriptor.digest,
    verificationProfileRef: profile.ref,
    verificationProfileVersion: profile.version,
    verificationProfileDigest: profile.digest,
    idempotencyKey: `verification-${Math.random()}`,
  };
  const run = await service.createRun(tenant, request);
  await new VerificationDispatchPublisher({
    ownerId: "publisher",
    store,
    queue,
    ...(now === undefined ? {} : { now }),
  }).drainOnce();
  return {
    store,
    queue,
    evidence,
    artifacts,
    source,
    profiles,
    service,
    run,
    sandbox: new LocalVerificationSandboxProvisioner(
      mkdtempSync(join(tmpdir(), "reef-verification-test-")),
    ),
  };
}

function worker(
  setup: Awaited<ReturnType<typeof fixture>>,
  workerId: string,
  extra: Partial<
    ConstructorParameters<typeof DeterministicVerificationWorker>[0]
  > = {},
): DeterministicVerificationWorker {
  return new DeterministicVerificationWorker({
    workerId,
    store: setup.store,
    queue: setup.queue,
    profiles: setup.profiles,
    materializer: new DeterministicSourceBundleMaterializer({
      store: setup.source,
    }),
    sandboxes: setup.sandbox,
    artifacts: setup.artifacts,
    evidence: setup.evidence,
    secrets: new EnvironmentProfileSecretResolver({}),
    leaseMs: 30_000,
    ...extra,
  });
}

function makeProfile(
  checks: TrustedVerificationProfile["checks"],
  maxDurationMs = 60_000,
): TrustedVerificationProfile {
  return defineTrustedProfile({
    ref: "verification-profile:test",
    version: "1.0.0",
    sandboxImageDigest: imageDigest,
    maxDurationMs,
    maxChecks: 20,
    checks,
  });
}

function check(
  checkRef: string,
  argv: readonly string[],
  expectedArtifacts?: TrustedVerificationProfile["checks"][number]["expectedArtifacts"],
): TrustedVerificationProfile["checks"][number] {
  return {
    checkRef,
    required: true,
    argv,
    workingDirectory: ".",
    timeoutMs: 5000,
    outputLimitBytes: 64 * 1024,
    environment: {},
    tool: { name: "node", version: process.version, imageDigest },
    ...(expectedArtifacts === undefined ? {} : { expectedArtifacts }),
  };
}

function sha(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for verification worker state");
}
