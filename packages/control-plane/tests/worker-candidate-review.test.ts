import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILDER_SOURCE_BUNDLE_BINDING_METADATA_KEY,
  ControlPlaneService,
  ControlPlaneWorker,
  InMemoryControlPlaneStore,
  InMemoryHumanReviewGateway,
  InMemoryRunQueue,
  type AcceptanceVerifier,
  type AgentKernel,
  type ArtifactRef,
  type ArtifactStore,
  type SandboxFinalizeRequest,
  type SandboxFinalizeResult,
  type SandboxHandle,
  type SandboxProvisioner,
  type SandboxSpec,
  type TenantScope,
} from "../src/index.js";
import { StaticSecretResolver } from "../src/adapters/local.js";

const SCOPE: TenantScope = { organisationId: "org-a", projectId: "project-a" };

const passAcceptance: AcceptanceVerifier = {
  verify: (_run, proof) =>
    Promise.resolve({ accepted: true, reason: "accepted", evidence: proof }),
};

const completedKernel: AgentKernel = {
  run: () => Promise.resolve({ outcome: "COMPLETED", output: "agent done" }),
};

class MemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, Uint8Array>();
  put(
    scope: TenantScope,
    runId: string,
    key: string,
    content: Uint8Array,
  ): Promise<ArtifactRef> {
    const uri = `mem://${runId}/${key}`;
    this.objects.set(uri, content);
    return Promise.resolve({
      ...scope,
      runId,
      key,
      uri,
      size: content.byteLength,
      sha256: "sha256-placeholder",
    });
  }
  get(ref: ArtifactRef): Promise<Uint8Array> {
    return Promise.resolve(this.objects.get(ref.uri) ?? new Uint8Array());
  }
}

const CANDIDATE_COMMIT = "a".repeat(40);
const REMOTE_URL =
  "https://git-codecommit.ap-southeast-2.amazonaws.com/v1/repos/reef-src";

function finalizeSandbox(record: {
  finalizeCalls: SandboxFinalizeRequest[];
}): SandboxProvisioner {
  const handle = (spec: SandboxSpec): SandboxHandle => ({
    id: `sandbox-${spec.runId}`,
    workspacePath: `/sandbox/${spec.runId}`,
    execute: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    finalize: (request: SandboxFinalizeRequest): Promise<SandboxFinalizeResult> => {
      record.finalizeCalls.push(request);
      return Promise.resolve({
        baseline: "b".repeat(40),
        commit: CANDIDATE_COMMIT,
        branch: request.candidateBranch,
        pushed: request.push === true,
        remoteUrl: REMOTE_URL,
        diff: "diff --git a/x b/x\n+candidate\n",
        diffTruncated: false,
        changed: true,
        test: {
          ran: true,
          command: ["python", "-m", "pytest", "-q"],
          exitCode: 0,
          passed: true,
          report: "1 passed",
          reportTruncated: false,
        },
      });
    },
  });
  return {
    provision: (spec) => Promise.resolve(handle(spec)),
    destroy: () => Promise.resolve(),
  };
}

function plainSandbox(): SandboxProvisioner {
  return {
    provision: (spec) =>
      Promise.resolve({
        id: `sandbox-${spec.runId}`,
        workspacePath: `/sandbox/${spec.runId}`,
        execute: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    destroy: () => Promise.resolve(),
  };
}

function app(options: {
  readonly sandboxes: SandboxProvisioner;
  readonly artifacts?: ArtifactStore;
}): {
  readonly store: InMemoryControlPlaneStore;
  readonly reviews: InMemoryHumanReviewGateway;
  readonly service: ControlPlaneService;
  readonly worker: ControlPlaneWorker;
} {
  const store = new InMemoryControlPlaneStore();
  const queue = new InMemoryRunQueue();
  const reviews = new InMemoryHumanReviewGateway();
  const service = new ControlPlaneService({
    runs: store,
    events: store,
    queue,
    reviews,
  });
  const worker = new ControlPlaneWorker({
    workerId: "candidate-worker",
    runs: store,
    events: store,
    checkpoints: store,
    queue,
    sandboxes: options.sandboxes,
    secrets: new StaticSecretResolver({}),
    reviews,
    acceptance: passAcceptance,
    kernel: completedKernel,
    ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
  });
  return { store, reviews, service, worker };
}

const BINDING = { schemaVersion: "octopus.reef.builder-source-bundle-binding/v1" };

test("path B: a source-binding run finalises to WAITING_FOR_REVIEW with a complete candidate reference set", async () => {
  const record = { finalizeCalls: [] as SandboxFinalizeRequest[] };
  const artifacts = new MemoryArtifactStore();
  const { store, reviews, service, worker } = app({
    sandboxes: finalizeSandbox(record),
    artifacts,
  });
  const created = await service.createRun(SCOPE, {
    task: "implement work item",
    idempotencyKey: "candidate-review",
    projectRef: "project://a",
    baselineRevisionRef: "b".repeat(40),
    metadata: { [BUILDER_SOURCE_BUNDLE_BINDING_METADATA_KEY]: BINDING },
    config: {
      candidateTestCommand: { argv: ["python", "-m", "pytest", "-q"] },
    },
  });

  assert.equal(await worker.runOnce(), true);

  const run = await service.getRun(SCOPE, created.id);
  assert.equal(run.status, "WAITING_FOR_REVIEW");
  assert.ok(run.reviewId);

  // Candidate references, exactly as Builder reads them off run.resultRefs.
  const refs = run.resultRefs;
  assert.equal(refs.diffRef, `codecommit:${REMOTE_URL}@${CANDIDATE_COMMIT}`);
  assert.equal(refs.testRef, `mem://${created.id}/candidate/attempt-0.test.txt`);
  assert.ok(Array.isArray(refs.evidenceRefs) && refs.evidenceRefs.length > 0);
  assert.ok(refs.evidenceRefs.every((r) => typeof r === "string" && r.length > 0));

  // Mirror of Builder's candidateReferencesAreComplete gate.
  const complete = Boolean(
    typeof refs.diffRef === "string" &&
      refs.diffRef.trim() &&
      typeof refs.testRef === "string" &&
      refs.testRef.trim() &&
      refs.evidenceRefs.length > 0,
  );
  assert.equal(complete, true);

  // The candidate diff + test report + proof were persisted as evidence.
  assert.ok(
    refs.evidenceRefs.includes(`mem://${created.id}/candidate/attempt-0.diff`),
  );
  assert.ok(refs.evidenceRefs.includes(refs.testRef!));
  assert.ok(refs.evidenceRefs.includes(refs.diffRef!));

  // The per-project test command from config was forwarded to the sandbox,
  // pushing to a per-run candidate branch.
  assert.equal(record.finalizeCalls.length, 1);
  assert.deepEqual(record.finalizeCalls[0]?.testCommand?.argv, [
    "python",
    "-m",
    "pytest",
    "-q",
  ]);
  assert.equal(record.finalizeCalls[0]?.push, true);
  assert.equal(record.finalizeCalls[0]?.candidateBranch, `reef-candidate/${created.id}-0`);

  // The review subsystem was triggered with the candidate context.
  const review = await reviews.get(SCOPE, run.reviewId!);
  assert.ok(review?.request.reason.includes("candidate ready for review"));

  // Exactly one run reached review, and the event trail records it.
  const events = await store.listEvents(SCOPE, created.id);
  const kinds = events.map((e) => e.type);
  assert.ok(kinds.includes("candidate.materialised"));
  assert.ok(kinds.includes("run.waiting_for_review"));
  assert.ok(!kinds.includes("run.completed"));

  // A second poll finds an empty queue: no duplicate run.
  assert.equal(await worker.runOnce(), false);
});

test("no source binding: the run completes without candidate materialisation", async () => {
  const record = { finalizeCalls: [] as SandboxFinalizeRequest[] };
  const { service, worker } = app({
    sandboxes: finalizeSandbox(record),
    artifacts: new MemoryArtifactStore(),
  });
  const created = await service.createRun(SCOPE, {
    task: "local run",
    idempotencyKey: "no-binding",
    projectRef: "project://a",
    baselineRevisionRef: "git://baseline/a",
  });
  await worker.runOnce();
  const run = await service.getRun(SCOPE, created.id);
  assert.equal(run.status, "COMPLETED");
  assert.equal(record.finalizeCalls.length, 0);
});

test("source binding but a sandbox that cannot finalise still completes (no silent gap)", async () => {
  const { service, worker } = app({ sandboxes: plainSandbox() });
  const created = await service.createRun(SCOPE, {
    task: "legacy sandbox",
    idempotencyKey: "no-finalize",
    projectRef: "project://a",
    baselineRevisionRef: "b".repeat(40),
    metadata: { [BUILDER_SOURCE_BUNDLE_BINDING_METADATA_KEY]: BINDING },
  });
  await worker.runOnce();
  const run = await service.getRun(SCOPE, created.id);
  assert.equal(run.status, "COMPLETED");
});
