import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  computeBundleDigest,
  defineTrustedProfile,
  type SourceBundleDescriptor,
  type TrustedVerificationProfile,
  type VerificationRunRequest,
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
    check("first", ["node", "-e", "require('fs').appendFileSync('first-count','x')"], [
      { path: "first-count", kind: "test-ref", mediaType: "text/plain", required: true, maxBytes: 10 },
    ]),
    check("second", ["node", "-e", "require('fs').writeFileSync('second-ok','ok')"]),
  ]);
  const setup = await fixture(profile, clock);
  let crash = true;
  const firstWorker = worker(setup, "worker-a", {
    now: clock,
    afterCheckpoint: () => {
      if (crash) { crash = false; throw new VerificationWorkerProcessCrash(); }
    },
  });
  await assert.rejects(firstWorker.runOnce(), VerificationWorkerProcessCrash);
  let interrupted = await setup.store.get(tenant, setup.run.runRef);
  assert.deepEqual(interrupted?.checks.map((result) => result.checkRef), ["first"]);

  now += 31_000;
  const secondWorker = worker(setup, "worker-b", { now: clock });
  assert.equal(await secondWorker.runOnce(), true);
  const completed = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.verdict?.outcome, "passed");
  assert.deepEqual(completed?.checks.map((result) => result.checkRef), ["first", "second"]);
  assert.equal((await setup.store.checkpoints(tenant, setup.run.runRef)).length, 2);
});

test("duplicate queue delivery is acknowledged without duplicate check execution", async () => {
  const profile = makeProfile([check("tests", ["node", "-e", "process.exit(0)"])]);
  const setup = await fixture(profile, undefined, true);
  const process = worker(setup, "worker-duplicate");
  assert.equal(await process.runOnce(), true);
  assert.equal(await process.runOnce(), true);
  const run = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(run?.state, "completed");
  assert.equal(run?.checks.length, 1);
  assert.equal((await setup.store.checkpoints(tenant, setup.run.runRef)).length, 1);
});

test("expired lease is fenced and can be taken over safely", async () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = (): string => new Date(now).toISOString();
  const setup = await fixture(makeProfile([check("tests", ["node", "-e", "process.exit(0)"])]), clock);
  const first = await setup.store.acquireLease(tenant, setup.run.runRef, "old", 1000, clock());
  assert.ok(first?.lease);
  now += 1001;
  const second = await setup.store.acquireLease(tenant, setup.run.runRef, "new", 1000, clock());
  assert.ok(second?.lease);
  assert.notEqual(second?.lease?.fencingToken, first?.lease?.fencingToken);
  assert.equal(await setup.store.assertFence(tenant, setup.run.runRef, first!.lease!.fencingToken), false);
  assert.equal(await setup.store.assertFence(tenant, setup.run.runRef, second!.lease!.fencingToken), true);
});

test("a failed required test is completed with failed verdict, not operational failed", async () => {
  const setup = await fixture(makeProfile([check("tests", ["node", "-e", "process.exit(7)"])]));
  await worker(setup, "worker-failing-test").runOnce();
  const run = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(run?.state, "completed");
  assert.equal(run?.verdict?.outcome, "failed");
  assert.equal(run?.failure, undefined);
  assert.equal(run?.checks[0]?.exitCode, 7);
});

test("profile duration exhaustion is an operational failure", async () => {
  const profile = makeProfile([
    check("first", ["node", "-e", "setTimeout(()=>{},20)"]),
    check("second", ["node", "-e", "process.exit(0)"]),
  ], 1);
  const setup = await fixture(profile);
  await worker(setup, "worker-budget", { maxInfrastructureRetries: 0 }).runOnce();
  const run = await setup.store.get(tenant, setup.run.runRef);
  assert.equal(run?.state, "failed");
  assert.equal(run?.failure?.code, "PROFILE_BUDGET_EXCEEDED");
  assert.equal(run?.verdict, undefined);
});

test("tenant isolation applies to runs, artifacts, and Evidence", async () => {
  const setup = await fixture(makeProfile([check("tests", ["node", "-e", "process.exit(0)"])]));
  await worker(setup, "worker-isolation").runOnce();
  const other = { organisationRef: "organisation:other", projectRef: tenant.projectRef };
  assert.equal(await setup.store.get(other, setup.run.runRef), undefined);
  const evidenceRef = (await setup.store.get(tenant, setup.run.runRef))!.verdict!.evidenceRef;
  assert.equal(await setup.evidence.get(other, evidenceRef), undefined);
  await assert.rejects(setup.service.getRun(other, setup.run.runRef), /not found/);
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
  const service = new VerificationService({ store, evidence, profiles, ...(now === undefined ? {} : { now }) });
  const content = Buffer.from("export const fixture = true;\n");
  const entry = { path: "fixture.js", size: content.byteLength, digest: sha(content), contentRef: "source-object:fixture" };
  const unsigned = {
    schemaVersion: "reef.source-bundle.v1" as const,
    ...tenant,
    sourceBundleRef: "source-bundle:fixture",
    unicodeNormalization: "NFC" as const,
    entries: [entry],
  };
  const descriptor: SourceBundleDescriptor = { ...unsigned, sourceBundleDigest: computeBundleDigest(unsigned) };
  source.add(descriptor, { [entry.contentRef]: content });
  const request: VerificationRunRequest = {
    ...tenant,
    candidateRef: "foundation-candidate:fixture",
    candidateDigest: sha(Buffer.from("candidate")),
    sourceBundleRef: descriptor.sourceBundleRef,
    sourceBundleDigest: descriptor.sourceBundleDigest,
    verificationProfileRef: profile.ref,
    verificationProfileVersion: profile.version,
    verificationProfileDigest: profile.digest,
    idempotencyKey: `verification-${Math.random()}`,
  };
  const run = await service.createRun(tenant, request);
  await new VerificationDispatchPublisher({ ownerId: "publisher", store, queue, ...(now === undefined ? {} : { now }) }).drainOnce();
  return {
    store, queue, evidence, artifacts, source, profiles, service, run,
    sandbox: new LocalVerificationSandboxProvisioner(mkdtempSync(join(tmpdir(), "reef-verification-test-"))),
  };
}

function worker(
  setup: Awaited<ReturnType<typeof fixture>>,
  workerId: string,
  extra: Partial<ConstructorParameters<typeof DeterministicVerificationWorker>[0]> = {},
): DeterministicVerificationWorker {
  return new DeterministicVerificationWorker({
    workerId, store: setup.store, queue: setup.queue, profiles: setup.profiles,
    materializer: new DeterministicSourceBundleMaterializer({ store: setup.source }),
    sandboxes: setup.sandbox, artifacts: setup.artifacts, evidence: setup.evidence,
    secrets: new EnvironmentProfileSecretResolver({}), leaseMs: 30_000,
    ...extra,
  });
}

function makeProfile(
  checks: TrustedVerificationProfile["checks"],
  maxDurationMs = 60_000,
): TrustedVerificationProfile {
  return defineTrustedProfile({
    ref: "verification-profile:test", version: "1.0.0", sandboxImageDigest: imageDigest,
    maxDurationMs, maxChecks: 20, checks,
  });
}

function check(
  checkRef: string,
  argv: readonly string[],
  expectedArtifacts?: TrustedVerificationProfile["checks"][number]["expectedArtifacts"],
): TrustedVerificationProfile["checks"][number] {
  return {
    checkRef, required: true, argv, workingDirectory: ".", timeoutMs: 5000,
    outputLimitBytes: 64 * 1024, environment: {}, tool: { name: "node", version: process.version, imageDigest },
    ...(expectedArtifacts === undefined ? {} : { expectedArtifacts }),
  };
}

function sha(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
