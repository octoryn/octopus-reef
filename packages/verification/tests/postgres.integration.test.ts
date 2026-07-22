import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DeterministicSourceBundleMaterializer,
  DeterministicVerificationWorker,
  StaticVerificationProfileRegistry,
  VerificationDispatchPublisher,
  VerificationService,
  VerificationWorkerProcessCrash,
  computeBundleDigest,
  defineTrustedProfile,
  type SourceBundleDescriptor,
  type VerificationRunRequest,
} from "../src/index.js";
import { PostgresVerificationStore } from "../src/adapters/postgres.js";
import {
  EnvironmentProfileSecretResolver,
  LocalSourceBundleStore,
  LocalVerificationArtifactStore,
  LocalVerificationEvidenceStore,
  LocalVerificationSandboxProvisioner,
} from "../src/adapters/local.js";

const databaseUrl = process.env["REEF_TEST_POSTGRES_URL"];

test("real PostgreSQL migration, restart recovery, duplicate delivery, fencing, and tenant isolation", {
  skip: databaseUrl === undefined ? "REEF_TEST_POSTGRES_URL is not configured" : false,
}, async () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = (): string => new Date(now).toISOString();
  const profile = defineTrustedProfile({
    ref: "verification-profile:postgres", version: "1.0.0",
    sandboxImageDigest: sha("sandbox"), maxDurationMs: 60_000, maxChecks: 2,
    checks: [
      check("first", ["node", "-e", "require('fs').writeFileSync('first','ok')"]),
      check("second", ["node", "-e", "require('fs').writeFileSync('second','ok')"]),
    ],
  });
  const profiles = new StaticVerificationProfileRegistry([profile]);
  const root = mkdtempSync(join(tmpdir(), "reef-verification-pg-"));
  const sourceRoot = join(root, "source");
  const tenant = { organisationRef: "organisation:pg", projectRef: "project:pg" };
  const descriptor = writeBundle(sourceRoot, tenant);
  const evidence = new LocalVerificationEvidenceStore(join(root, "evidence"));
  const artifacts = new LocalVerificationArtifactStore(join(root, "artifacts"));
  const sandbox = new LocalVerificationSandboxProvisioner(join(root, "workspaces"));

  let store = new PostgresVerificationStore(databaseUrl!, { now: clock });
  await store.migrate();
  await store.ready();
  const service = new VerificationService({ store, evidence, profiles, now: clock, id: () => "verification:pg-restart" });
  const run = await service.createRun(tenant, request(tenant, descriptor, profile, "create-pg"));
  await new VerificationDispatchPublisher({ ownerId: "publisher", store, queue: store, now: clock }).drainOnce();
  let crash = true;
  const firstWorker = makeWorker(store, "old-worker", profiles, sourceRoot, evidence, artifacts, sandbox, clock, () => {
    if (crash) { crash = false; throw new VerificationWorkerProcessCrash(); }
  });
  await assert.rejects(firstWorker.runOnce(), VerificationWorkerProcessCrash);
  assert.deepEqual((await store.get(tenant, run.runRef))?.checks.map((item) => item.checkRef), ["first"]);
  await store.close();

  now += 31_000;
  store = new PostgresVerificationStore(databaseUrl!, { now: clock });
  const resumed = makeWorker(store, "new-worker", profiles, sourceRoot, evidence, artifacts, sandbox, clock);
  assert.equal(await resumed.runOnce(), true);
  const completed = await store.get(tenant, run.runRef);
  assert.equal(completed?.state, "completed");
  assert.deepEqual(completed?.checks.map((item) => item.checkRef), ["first", "second"]);
  assert.equal((await store.checkpoints(tenant, run.runRef)).length, 2);

  await store.enqueue(tenant, run.runRef, run.attempt);
  assert.equal(await resumed.runOnce(), true);
  assert.equal((await store.checkpoints(tenant, run.runRef)).length, 2);

  const otherTenant = { organisationRef: "organisation:other", projectRef: tenant.projectRef };
  assert.equal(await store.get(otherTenant, run.runRef), undefined);
  const otherService = new VerificationService({ store, evidence, profiles, now: clock, id: () => run.runRef });
  const otherRun = await otherService.createRun(otherTenant, request(otherTenant, writeBundle(sourceRoot, otherTenant), profile, "create-pg"));
  assert.equal(otherRun.runRef, run.runRef);
  assert.equal((await store.events(otherTenant, run.runRef)).length, 1);
  assert.ok(BigInt(otherRun.eventCursor) > BigInt(completed!.eventCursor));
  await store.close();
});

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
    workerId, store, queue: store, profiles,
    materializer: new DeterministicSourceBundleMaterializer({ store: new LocalSourceBundleStore(sourceRoot) }),
    sandboxes: sandbox, evidence, artifacts, secrets: new EnvironmentProfileSecretResolver({}),
    leaseMs: 30_000, now, ...(afterCheckpoint === undefined ? {} : { afterCheckpoint }),
  });
}

function writeBundle(
  root: string,
  tenant: { organisationRef: string; projectRef: string },
): SourceBundleDescriptor {
  mkdirSync(root, { recursive: true });
  const content = Buffer.from("export const postgresFixture = true;\n");
  const entry = { path: "fixture.js", size: content.byteLength, digest: shaBytes(content), contentRef: "source-object:pg" };
  const unsigned = { schemaVersion: "reef.source-bundle.v1" as const, ...tenant, sourceBundleRef: "source-bundle:pg", unicodeNormalization: "NFC" as const, entries: [entry] };
  const descriptor: SourceBundleDescriptor = { ...unsigned, sourceBundleDigest: computeBundleDigest(unsigned) };
  const tenantDirectory = hash(`${tenant.organisationRef}\0${tenant.projectRef}`).slice(0, 32);
  const descriptorPath = join(root, tenantDirectory, "bundles", hash(descriptor.sourceBundleRef), "descriptor.json");
  const objectPath = join(root, tenantDirectory, "objects", hash(entry.contentRef));
  mkdirSync(dirname(descriptorPath), { recursive: true }); mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify(descriptor)); writeFileSync(objectPath, content);
  return descriptor;
}

function request(
  tenant: { organisationRef: string; projectRef: string },
  descriptor: SourceBundleDescriptor,
  profile: ReturnType<typeof defineTrustedProfile>,
  idempotencyKey: string,
): VerificationRunRequest {
  return {
    ...tenant, candidateRef: "foundation-candidate:pg", candidateDigest: sha("candidate"),
    sourceBundleRef: descriptor.sourceBundleRef, sourceBundleDigest: descriptor.sourceBundleDigest,
    verificationProfileRef: profile.ref, verificationProfileVersion: profile.version,
    verificationProfileDigest: profile.digest, idempotencyKey,
  };
}

function check(checkRef: string, argv: readonly string[]) {
  return {
    checkRef, required: true, argv, workingDirectory: ".", timeoutMs: 5000,
    outputLimitBytes: 4096, environment: {},
    tool: { name: "node", version: process.version, imageDigest: sha("tool") },
  } as const;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sha(value: string): string { return `sha256:${hash(value)}`; }
function shaBytes(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
