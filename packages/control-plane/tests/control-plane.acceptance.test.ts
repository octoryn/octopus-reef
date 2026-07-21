import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ControlPlaneService,
  ControlPlaneWorker,
  InMemoryControlPlaneStore,
  InMemoryHumanReviewGateway,
  InMemoryRunQueue,
  WorkerProcessCrash,
  type AcceptanceVerifier,
  type AgentKernel,
  type KernelContext,
  type KernelResult,
  type QueueClaimOptions,
  type QueueLease,
  type QueueMessage,
  type RunQueue,
  type SandboxHandle,
  type SandboxProvisioner,
  type SandboxSpec,
  type TenantScope,
} from "../src/index.js";
import {
  DockerSandboxProvisioner,
  StaticSecretResolver,
  type CommandRunner,
} from "../src/adapters/local.js";
import {
  PostgresControlPlaneStore,
  PostgresHumanReviewGateway,
  PostgresOutbox,
} from "../src/adapters/postgres.js";

const SCOPE: TenantScope = {
  organisationId: "org-a",
  projectId: "project-a",
};

class ManualClock {
  #milliseconds = 0;
  now = (): string => new Date(this.#milliseconds).toISOString();
  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }
}

const passAcceptance: AcceptanceVerifier = {
  verify: (_run, proof) =>
    Promise.resolve({ accepted: true, reason: "accepted", evidence: proof }),
};

class FakeSandboxProvisioner implements SandboxProvisioner {
  provision(spec: SandboxSpec): Promise<SandboxHandle> {
    return Promise.resolve({
      id: `sandbox-${spec.organisationId}-${spec.projectId}-${spec.runId}`,
      workspacePath: `/sandbox/${spec.organisationId}/${spec.projectId}/${spec.runId}`,
      execute: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    });
  }
  destroy(_handle: SandboxHandle): Promise<void> {
    return Promise.resolve();
  }
}

function runtime(
  clock: ManualClock,
  kernel: AgentKernel,
  options: {
    readonly queue?: RunQueue;
    readonly afterCheckpoint?: ConstructorParameters<
      typeof ControlPlaneWorker
    >[0]["afterCheckpoint"];
  } = {},
): {
  readonly store: InMemoryControlPlaneStore;
  readonly queue: RunQueue;
  readonly reviews: InMemoryHumanReviewGateway;
  readonly service: ControlPlaneService;
  worker(id: string): ControlPlaneWorker;
} {
  const store = new InMemoryControlPlaneStore({ now: clock.now });
  const queue = options.queue ?? new InMemoryRunQueue({ now: clock.now });
  const reviews = new InMemoryHumanReviewGateway();
  const service = new ControlPlaneService({
    runs: store,
    events: store,
    queue,
    reviews,
    now: clock.now,
  });
  return {
    store,
    queue,
    reviews,
    service,
    worker: (id) =>
      new ControlPlaneWorker({
        workerId: id,
        runs: store,
        events: store,
        checkpoints: store,
        queue,
        sandboxes: new FakeSandboxProvisioner(),
        secrets: new StaticSecretResolver({}),
        reviews,
        acceptance: passAcceptance,
        kernel,
        leaseMs: 1_000,
        retryBaseMs: 0,
        now: clock.now,
        ...(options.afterCheckpoint !== undefined
          ? { afterCheckpoint: options.afterCheckpoint }
          : {}),
      }),
  };
}

test("worker killed after tool result resumes without executing the tool twice", async () => {
  const clock = new ManualClock();
  let toolExecutions = 0;
  const kernel: AgentKernel = {
    async run(context: KernelContext): Promise<KernelResult> {
      if (context.resumeFrom?.idempotencyKey.endsWith("tool-result:tool-1")) {
        return { outcome: "COMPLETED", output: "resumed" };
      }
      await context.checkpoint({
        kind: "MODEL_RESPONSE",
        idempotencyKey: "model-response:0",
        payload: { turn: 0 },
      });
      await context.checkpoint({
        kind: "TOOL_INTENT",
        idempotencyKey: "tool-intent:tool-1",
        payload: { tool: "write" },
        step: { id: "tool-1", kind: "write", input: { path: "a.txt" } },
      });
      toolExecutions++;
      await context.checkpoint({
        kind: "TOOL_RESULT",
        idempotencyKey: "tool-result:tool-1",
        payload: { result: "ok" },
        usage: { toolCalls: 1, outputBytes: 2 },
        step: { id: "tool-1", kind: "write", output: "ok" },
      });
      return { outcome: "COMPLETED", output: "first process" };
    },
  };
  let crash = true;
  const app = runtime(clock, kernel, {
    afterCheckpoint(checkpoint) {
      if (crash && checkpoint.kind === "TOOL_RESULT") {
        crash = false;
        throw new WorkerProcessCrash();
      }
    },
  });
  const run = await app.service.createRun(SCOPE, {
    task: "write a file",
    idempotencyKey: "run-crash",
    projectRef: "project://a",
  });

  await assert.rejects(app.worker("worker-1").runOnce(), WorkerProcessCrash);
  assert.equal(toolExecutions, 1);
  assert.equal(
    (await app.store.listSteps(SCOPE, run.id))[0]?.status,
    "COMPLETED",
  );

  clock.advance(1_001);
  assert.equal(await app.worker("worker-2").runOnce(), true);
  assert.equal(toolExecutions, 1);
  assert.equal((await app.service.getRun(SCOPE, run.id)).status, "COMPLETED");
});

test("duplicate SQS deliveries do not execute an AgentRun twice", async () => {
  const clock = new ManualClock();
  const duplicateQueue = new SqsDuplicateQueueFake(clock.now);
  let executions = 0;
  const kernel: AgentKernel = {
    run: () => {
      executions++;
      return Promise.resolve({ outcome: "COMPLETED", output: "once" });
    },
  };
  const app = runtime(clock, kernel, { queue: duplicateQueue });
  await app.service.createRun(SCOPE, {
    task: "deduplicate",
    idempotencyKey: "sqs-duplicate",
    projectRef: "project://a",
  });

  await app.worker("worker-a").runOnce();
  await app.worker("worker-b").runOnce();
  assert.equal(executions, 1);
  assert.equal(duplicateQueue.acks, 2);
});

test("expired lease can be taken over and stale fencing token cannot commit", async () => {
  const clock = new ManualClock();
  const app = runtime(clock, {
    run: () => Promise.resolve({ outcome: "COMPLETED", output: "ok" }),
  });
  const created = await app.service.createRun(SCOPE, {
    task: "lease",
    idempotencyKey: "lease",
    projectRef: "project://a",
  });
  const first = await app.store.acquireLease(SCOPE, created.id, {
    ownerId: "worker-1",
    leaseMs: 1_000,
    now: clock.now(),
  });
  assert.ok(first?.lease);
  clock.advance(1_001);
  const second = await app.store.acquireLease(SCOPE, created.id, {
    ownerId: "worker-2",
    leaseMs: 1_000,
    now: clock.now(),
  });
  assert.ok(second?.lease);
  assert.ok(second.lease.fencingToken > first.lease.fencingToken);
  const stale = await app.store.mutate(
    SCOPE,
    created.id,
    second.version,
    { status: "PROVISIONING" },
    first.lease.fencingToken,
  );
  assert.equal(stale, undefined);
});

test("review pause survives service/worker restart until explicit approval", async () => {
  const clock = new ManualClock();
  let executions = 0;
  const app = runtime(clock, {
    run: () => {
      executions++;
      return Promise.resolve({ outcome: "COMPLETED", output: "approved" });
    },
  });
  const run = await app.service.createRun(SCOPE, {
    task: "review",
    idempotencyKey: "review",
    projectRef: "project://a",
  });
  await app.service.pause(SCOPE, run.id, "human gate", "reviewer-1");

  const restartedService = new ControlPlaneService({
    runs: app.store,
    events: app.store,
    queue: app.queue,
    reviews: app.reviews,
    now: clock.now,
  });
  assert.equal(
    (await restartedService.getRun(SCOPE, run.id)).status,
    "WAITING_FOR_REVIEW",
  );
  assert.equal(executions, 0);
  await restartedService.approve(SCOPE, run.id, "reviewer-2", "looks good");
  await app.worker("worker-after-restart").runOnce();
  assert.equal(executions, 1);
  assert.equal(
    (await restartedService.getRun(SCOPE, run.id)).status,
    "COMPLETED",
  );
});

test("budget exhaustion terminates as BUDGET_EXCEEDED", async () => {
  const clock = new ManualClock();
  const app = runtime(clock, {
    async run(context) {
      await context.checkpoint({
        kind: "MODEL_RESPONSE",
        idempotencyKey: "model-response:0",
        payload: { response: "too expensive" },
        usage: { tokens: 11, costUsd: 1.1 },
      });
      return { outcome: "COMPLETED", output: "must not complete" };
    },
  });
  const run = await app.service.createRun(SCOPE, {
    task: "bounded",
    idempotencyKey: "budget",
    projectRef: "project://a",
    budget: { maxTokens: 10 },
  });
  await app.worker("budget-worker").runOnce();
  const finished = await app.service.getRun(SCOPE, run.id);
  assert.equal(finished.status, "BUDGET_EXCEEDED");
  assert.equal(finished.usage.tokens, 11);
  assert.equal(finished.failure?.code, "BUDGET_EXCEEDED");
});

test("Run API accepts secretRef and rejects plaintext credentials at any depth", async () => {
  const clock = new ManualClock();
  const app = runtime(clock, {
    run: () => Promise.resolve({ outcome: "COMPLETED", output: "ok" }),
  });
  await app.service.createRun(SCOPE, {
    task: "secret refs only",
    idempotencyKey: "secret-ref",
    projectRef: "project://a",
    secretRefs: [{ name: "model", secretRef: "vault://models/prod" }],
  });
  await assert.rejects(
    app.service.createRun(SCOPE, {
      task: "bad secret",
      idempotencyKey: "plaintext-secret",
      projectRef: "project://a",
      apiKey: "plaintext",
    } as never),
    /plaintext credential.*secretRefs/,
  );
  await assert.rejects(
    app.service.createRun(SCOPE, {
      task: "nested bad secret",
      idempotencyKey: "nested-plaintext-secret",
      projectRef: "project://a",
      config: { provider: { authorization: "Bearer plaintext" } },
    }),
    /plaintext credential.*secretRefs/,
  );
});

test("organisation/project records and workspace paths are isolated", async () => {
  const clock = new ManualClock();
  const store = new InMemoryControlPlaneStore({ now: clock.now });
  const queue = new InMemoryRunQueue({ now: clock.now });
  const reviews = new InMemoryHumanReviewGateway();
  const ids = ["same-run-id", "same-run-id"];
  const service = new ControlPlaneService({
    runs: store,
    events: store,
    queue,
    reviews,
    now: clock.now,
    id: () => ids.shift()!,
  });
  const scopeB = { organisationId: "org-b", projectId: "project-b" };
  const runA = await service.createRun(SCOPE, {
    task: "tenant A",
    idempotencyKey: "same-client-key",
    projectRef: "project://a",
  });
  const runB = await service.createRun(scopeB, {
    task: "tenant B",
    idempotencyKey: "same-client-key",
    projectRef: "project://b",
  });
  assert.equal(runA.id, runB.id);
  assert.equal((await service.getRun(SCOPE, runA.id)).task, "tenant A");
  assert.equal((await service.getRun(scopeB, runB.id)).task, "tenant B");
  assert.equal((await service.events(SCOPE, runA.id)).length, 1);
  assert.equal((await service.events(scopeB, runB.id)).length, 1);

  const sandbox = new FakeSandboxProvisioner();
  const a = await sandbox.provision({
    ...SCOPE,
    runId: runA.id,
    projectRef: runA.projectRef,
    attempt: 0,
  });
  const b = await sandbox.provision({
    ...scopeB,
    runId: runB.id,
    projectRef: runB.projectRef,
    attempt: 0,
  });
  assert.notEqual(a.workspacePath, b.workspacePath);
});

test("Docker sandbox denies host/workspace/IMDS access by construction", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(argv) {
      calls.push([...argv]);
      return Promise.resolve({
        exitCode: 0,
        stdout: argv[1] === "create" ? "container-id\n" : "",
        stderr: "",
      });
    },
  };
  const root = `/tmp/reef-control-plane-test-${process.pid}-${Date.now()}`;
  const provisioner = new DockerSandboxProvisioner({
    root,
    image: "reef-agent:test",
    runner,
    user: "65532:65532",
  });
  const handle = await provisioner.provision({
    ...SCOPE,
    runId: "sandbox-run",
    projectRef: "opaque://project",
    attempt: 0,
  });
  const create = calls[0]!;
  assert.deepEqual(flagValue(create, "--network"), "none");
  assert.ok(create.includes("--read-only"));
  assert.deepEqual(flagValue(create, "--cap-drop"), "ALL");
  assert.deepEqual(
    flagValue(create, "--security-opt"),
    "no-new-privileges:true",
  );
  assert.deepEqual(flagValue(create, "--user"), "65532:65532");
  assert.ok(create.includes("AWS_EC2_METADATA_DISABLED=true"));
  const mounts = create.filter(
    (value, index) => create[index - 1] === "--mount",
  );
  assert.equal(mounts.length, 1);
  assert.ok(mounts[0]?.endsWith(",dst=/workspace"));
  assert.throws(
    () => handle.execute({ argv: ["pwd"], cwd: "../../other-workspace" }),
    /escapes workspace/,
  );
});

test(
  "PostgreSQL migration and durable run/event/checkpoint/queue path",
  { skip: process.env.REEF_TEST_POSTGRES_URL === undefined },
  async () => {
    const connectionString = process.env.REEF_TEST_POSTGRES_URL!;
    const store = new PostgresControlPlaneStore(connectionString);
    await store.migrate();
    const reviews = new PostgresHumanReviewGateway(connectionString);
    const service = new ControlPlaneService({
      runs: store,
      events: store,
      queue: store,
      reviews,
    });
    const run = await service.createRun(SCOPE, {
      task: "postgres durable execution",
      idempotencyKey: `postgres-${Date.now()}`,
      projectRef: "project://postgres",
    });
    const worker = new ControlPlaneWorker({
      workerId: "postgres-worker",
      runs: store,
      events: store,
      checkpoints: store,
      queue: store,
      sandboxes: new FakeSandboxProvisioner(),
      secrets: new StaticSecretResolver({}),
      reviews,
      acceptance: passAcceptance,
      kernel: {
        run: () =>
          Promise.resolve({ outcome: "COMPLETED", output: "postgres ok" }),
      },
    });
    try {
      assert.equal(await worker.runOnce(), true);
      assert.equal((await service.getRun(SCOPE, run.id)).status, "COMPLETED");
      assert.ok((await store.listEvents(SCOPE, run.id)).length > 0);
      assert.equal((await store.listCheckpoints(SCOPE, run.id)).length, 1);
      const outbox = new PostgresOutbox(connectionString);
      const claimed = await outbox.claim("publisher-1", 30_000);
      assert.ok(claimed.length > 0);
      await outbox.published(claimed[0]!.id, "publisher-1");
      await outbox.close();

      const reviewRun = await service.createRun(SCOPE, {
        task: "postgres review persistence",
        idempotencyKey: `postgres-review-${Date.now()}`,
        projectRef: "project://postgres",
      });
      const paused = await service.pause(SCOPE, reviewRun.id, "persist review");
      assert.ok(paused.reviewId);
      const restartedReviews = new PostgresHumanReviewGateway(connectionString);
      assert.equal(
        (await restartedReviews.get(SCOPE, paused.reviewId))?.request.reason,
        "persist review",
      );
      await restartedReviews.close();
    } finally {
      await reviews.close();
      await store.close();
    }
  },
);

test(
  "Docker sandbox runtime cannot see host/peer workspace or AWS IMDS",
  { skip: process.env.REEF_TEST_DOCKER_IMAGE === undefined },
  async () => {
    // Docker Desktop/remote contexts reliably share the repository's /Users
    // path, while the OS temp directory may not be bind-mounted into the VM.
    const root = mkdtempSync(join(process.cwd(), ".reef-docker-acceptance-"));
    const peer = join(root, "peer-workspace");
    mkdirSync(peer);
    writeFileSync(join(peer, "secret.txt"), "must-not-be-visible");
    const provisioner = new DockerSandboxProvisioner({
      root,
      image: process.env.REEF_TEST_DOCKER_IMAGE!,
    });
    let handle: SandboxHandle | undefined;
    try {
      handle = await provisioner.provision({
        ...SCOPE,
        runId: "real-docker-isolation",
        projectRef: "project://docker",
        attempt: 0,
      });
      const visibility = await handle.execute({
        argv: [
          "node",
          "-e",
          [
            "const fs=require('node:fs')",
            `const host=${JSON.stringify(root)}`,
            `const peer=${JSON.stringify(peer)}`,
            "fs.writeFileSync('/workspace/inside.txt','ok')",
            "console.log(JSON.stringify({host:fs.existsSync(host),peer:fs.existsSync(peer),inside:fs.readFileSync('/workspace/inside.txt','utf8')}))",
          ].join(";"),
        ],
      });
      assert.equal(visibility.exitCode, 0, visibility.stderr);
      assert.deepEqual(JSON.parse(visibility.stdout.trim()), {
        host: false,
        peer: false,
        inside: "ok",
      });
      const imds = await handle.execute({
        argv: [
          "node",
          "-e",
          "fetch('http://169.254.169.254/latest/meta-data/',{signal:AbortSignal.timeout(500)}).then(()=>process.exit(9)).catch(()=>process.exit(0))",
        ],
        timeoutMs: 2_000,
      });
      assert.equal(imds.exitCode, 0, "IMDS must be unreachable");
    } finally {
      if (handle !== undefined) await provisioner.destroy(handle);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

class SqsDuplicateQueueFake implements RunQueue {
  readonly #now: () => string;
  readonly #messages: QueueMessage[] = [];
  readonly #leased = new Map<string, QueueLease>();
  acks = 0;

  constructor(now: () => string) {
    this.#now = now;
  }

  enqueue(scope: TenantScope, runId: string): Promise<void> {
    const base: QueueMessage = {
      ...scope,
      id: "sqs-message",
      runId,
      attempt: 0,
      availableAt: this.#now(),
    };
    this.#messages.push(base, { ...base });
    return Promise.resolve();
  }

  claim(options: QueueClaimOptions): Promise<QueueLease | undefined> {
    const message = this.#messages.shift();
    if (message === undefined) return Promise.resolve(undefined);
    const lease: QueueLease = {
      message,
      receipt: `receipt-${this.#leased.size}`,
      ownerId: options.workerId,
      fencingToken: 1,
      expiresAt: new Date(
        Date.parse(options.now) + options.leaseMs,
      ).toISOString(),
    };
    this.#leased.set(lease.receipt, lease);
    return Promise.resolve(lease);
  }

  heartbeat(lease: QueueLease, _expiresAt: string): Promise<boolean> {
    return Promise.resolve(this.#leased.has(lease.receipt));
  }

  ack(lease: QueueLease): Promise<void> {
    this.#leased.delete(lease.receipt);
    this.acks++;
    return Promise.resolve();
  }

  retry(lease: QueueLease, availableAt: string): Promise<void> {
    this.#leased.delete(lease.receipt);
    this.#messages.push({ ...lease.message, availableAt });
    return Promise.resolve();
  }
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}
