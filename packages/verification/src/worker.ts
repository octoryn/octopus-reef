import { createHash } from "node:crypto";
import { clearInterval, setInterval as startInterval } from "node:timers";
import type {
  SourceBundleMaterializer,
  TrustedVerificationProfileRegistry,
  VerificationArtifactStore,
  VerificationEvidenceStore,
  VerificationQueue,
  VerificationSandboxProvisioner,
  VerificationSecretResolver,
  VerificationStore,
} from "./ports.js";
import type {
  TrustedVerificationProfile,
  VerificationArtifact,
  VerificationCheckDefinition,
  VerificationCheckResult,
  VerificationRun,
  VerificationSandbox,
  VerificationTenant,
  VerificationVerdict,
} from "./types.js";
import {
  createCheckEvidence,
  createVerdictEvidence,
  parseArtifactReference,
  putVerifiedEvidence,
} from "./evidence.js";
import {
  bindVerificationEventData,
  verificationRunIdentity,
} from "./identity.js";

export interface DeterministicVerificationWorkerOptions {
  readonly workerId: string;
  readonly store: VerificationStore;
  readonly queue: VerificationQueue;
  readonly profiles: TrustedVerificationProfileRegistry;
  readonly materializer: SourceBundleMaterializer;
  readonly sandboxes: VerificationSandboxProvisioner;
  readonly artifacts: VerificationArtifactStore;
  readonly evidence: VerificationEvidenceStore;
  readonly secrets: VerificationSecretResolver;
  readonly leaseMs?: number;
  readonly maxInfrastructureRetries?: number;
  readonly retryBaseMs?: number;
  readonly now?: () => string;
  readonly afterCheckpoint?: (
    result: VerificationCheckResult,
    run: VerificationRun,
  ) => Promise<void> | void;
  /** Deployment-local observability hook. Errors must never enter the public Run payload. */
  readonly onInfrastructureError?: (
    error: unknown,
    run: VerificationRun,
  ) => Promise<void> | void;
}

export class VerificationWorkerProcessCrash extends Error {
  constructor(message = "verification worker process crashed") {
    super(message);
    this.name = "VerificationWorkerProcessCrash";
  }
}

export class DeterministicVerificationWorker {
  readonly #options: DeterministicVerificationWorkerOptions;
  readonly #leaseMs: number;
  readonly #now: () => string;

  constructor(options: DeterministicVerificationWorkerOptions) {
    this.#options = options;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async runOnce(): Promise<boolean> {
    const queueLease = await this.#options.queue.claim(
      this.#options.workerId,
      this.#leaseMs,
      this.#now(),
    );
    if (queueLease === undefined) return false;
    const tenant: VerificationTenant = {
      organisationRef: queueLease.message.organisationRef,
      projectRef: queueLease.message.projectRef,
    };
    let run = await this.#options.store.acquireLease(
      tenant,
      queueLease.message.runRef,
      this.#options.workerId,
      this.#leaseMs,
      this.#now(),
    );
    if (run === undefined) {
      await this.#options.queue.ack(queueLease);
      return true;
    }
    const fence = run.lease!.fencingToken;
    const abort = new AbortController();
    let crashed = false;
    let sandbox: VerificationSandbox | undefined;
    const heartbeat = startInterval(
      () => {
        const expiresAt = new Date(
          Date.parse(this.#now()) + this.#leaseMs,
        ).toISOString();
        void Promise.all([
          this.#options.store.heartbeatLease(
            tenant,
            run!.runRef,
            this.#options.workerId,
            fence,
            expiresAt,
          ),
          this.#options.queue.heartbeat(queueLease, expiresAt),
        ]).then(([runOk, queueOk]) => {
          if (!runOk || !queueOk)
            abort.abort(new Error("verification lease lost"));
        });
      },
      Math.max(100, Math.floor(this.#leaseMs / 3)),
    );
    heartbeat.unref();

    try {
      run = await this.#transition(tenant, run, fence, "provisioning");
      const profile = await this.#options.profiles.resolve(run);
      const spec = {
        ...verificationRunIdentity(run),
        runRef: run.runRef,
        attempt: run.attempt,
        imageDigest: profile.sandboxImageDigest,
      };
      sandbox =
        (run.sandboxRef !== undefined
          ? await this.#options.sandboxes.restore?.(
              spec,
              run.sandboxRef,
              abort.signal,
            )
          : undefined) ??
        (await this.#options.sandboxes.provision(spec, abort.signal));
      run = await this.#mutate(
        tenant,
        run,
        fence,
        { sandboxRef: sandbox.id },
        "verification.sandbox_ready",
        { sandboxRef: sandbox.id },
      );
      const materialization = await this.#options.materializer.materialize(
        run,
        sandbox,
        abort.signal,
      );
      if (run.materialization === undefined) {
        run = await this.#mutate(
          tenant,
          run,
          fence,
          { materialization },
          "verification.materialized",
          { materialization },
        );
      }
      run = await this.#transition(tenant, run, fence, "running");
      const executionStarted = Date.now();
      for (const check of profile.checks) {
        if (run.checks.some((result) => result.checkRef === check.checkRef))
          continue;
        if (Date.now() - executionStarted >= profile.maxDurationMs) {
          throw new Error("verification profile duration budget exceeded");
        }
        run = await this.#executeCheck(
          tenant,
          run,
          fence,
          profile,
          check,
          sandbox,
          abort.signal,
        );
      }
      const verdictBase = requiredVerdict(run, profile, run.checks);
      await this.#assertFence(tenant, run.runRef, fence);
      const verdictEvidence = createVerdictEvidence(
        { ...run, version: run.version + 1 },
        profile,
        verdictBase,
        run.checks.map((check) => ({
          ref: check.evidenceRef,
          digest: check.evidenceDigest,
        })),
        this.#now(),
      );
      const storedVerdict = await putVerifiedEvidence(
        this.#options.evidence,
        tenant,
        verdictEvidence,
      );
      await this.#assertFence(tenant, run.runRef, fence);
      const verdict: VerificationVerdict = {
        ...verdictBase,
        evidenceRef: storedVerdict.ref,
        evidenceDigest: storedVerdict.digest,
      };
      const finishedAt = this.#now();
      run = await this.#mutate(
        tenant,
        run,
        fence,
        {
          state: "completed",
          verdict,
          finishedAt,
          clearLease: true,
        },
        "verification.completed",
        { identity: verificationRunIdentity(run), verdict },
      );
      await this.#options.queue.ack(queueLease);
      return true;
    } catch (error) {
      if (error instanceof VerificationWorkerProcessCrash) {
        crashed = true;
        throw error;
      }
      try {
        await this.#options.onInfrastructureError?.(error, run);
      } catch {
        // Observability must not change retry, fencing, or product-safe failure semantics.
      }
      const current = await this.#options.store.get(tenant, run.runRef);
      if (current?.state === "cancelled") {
        await this.#options.queue.ack(queueLease);
        return true;
      }
      if (abort.signal.aborted) {
        // A stale worker must neither acknowledge the delivery nor publish a
        // terminal state. The queue visibility timeout and run lease permit a
        // fenced worker to take over safely.
        return true;
      }
      const maxRetries = this.#options.maxInfrastructureRetries ?? 2;
      if (run.attempt <= maxRetries) {
        const delay =
          (this.#options.retryBaseMs ?? 500) * 2 ** (run.attempt - 1);
        const availableAt = new Date(
          Date.parse(this.#now()) + delay,
        ).toISOString();
        const retried = await this.#mutate(
          tenant,
          run,
          fence,
          {
            state: "queued",
            attempt: run.attempt + 1,
            clearLease: true,
            clearMaterialization: true,
          },
          "verification.infrastructure_retry",
          { attempt: run.attempt + 1, retryAt: availableAt },
        );
        run = retried;
        await this.#options.queue.retry(queueLease, availableAt);
        return true;
      }
      const finishedAt = this.#now();
      await this.#mutate(
        tenant,
        run,
        fence,
        {
          state: "failed",
          failure: {
            code: safeFailureCode(error),
            message:
              "verification infrastructure failed; retry with the same identity",
            retryable: true,
          },
          finishedAt,
          clearLease: true,
        },
        "verification.failed",
        {
          code: safeFailureCode(error),
          identity: verificationRunIdentity(run),
        },
      );
      await this.#options.queue.ack(queueLease);
      return true;
    } finally {
      clearInterval(heartbeat);
      if (!crashed && sandbox !== undefined) {
        await this.#options.sandboxes.destroy(sandbox).catch(() => undefined);
      }
    }
  }

  async #executeCheck(
    tenant: VerificationTenant,
    run: VerificationRun,
    fence: number,
    profile: TrustedVerificationProfile,
    check: VerificationCheckDefinition,
    sandbox: VerificationSandbox,
    signal: AbortSignal,
  ): Promise<VerificationRun> {
    const startedAt = this.#now();
    const started = Date.now();
    const secretEnvironment = await this.#options.secrets.resolve(
      tenant,
      check.secretBindings ?? [],
    );
    const command = await sandbox.execute(
      check,
      { ...check.environment, ...secretEnvironment },
      signal,
    );
    await this.#assertFence(tenant, run.runRef, fence);
    const artifacts: VerificationArtifact[] = [];
    if (command.stdout.byteLength > 0) {
      artifacts.push(
        await this.#publishArtifact(
          tenant,
          run.runRef,
          fence,
          `${check.checkRef}.stdout`,
          "text/plain; charset=utf-8",
          command.stdout.subarray(0, check.outputLimitBytes),
        ),
      );
    }
    if (command.stderr.byteLength > 0) {
      artifacts.push(
        await this.#publishArtifact(
          tenant,
          run.runRef,
          fence,
          `${check.checkRef}.stderr`,
          "text/plain; charset=utf-8",
          command.stderr.subarray(0, check.outputLimitBytes),
        ),
      );
    }
    let requiredArtifactMissing = false;
    for (const expected of check.expectedArtifacts ?? []) {
      const content = await sandbox.readFile(
        expected.path,
        expected.maxBytes,
        signal,
      );
      if (content === undefined) {
        if (expected.required) {
          requiredArtifactMissing = true;
          artifacts.push(
            await this.#publishArtifact(
              tenant,
              run.runRef,
              fence,
              `${check.checkRef}.missing-artifact`,
              "application/json",
              Buffer.from(JSON.stringify({ missing: expected.path }), "utf8"),
            ),
          );
        }
        continue;
      }
      artifacts.push(
        await this.#publishArtifact(
          tenant,
          run.runRef,
          fence,
          expected.kind,
          expected.mediaType,
          content,
        ),
      );
    }
    await this.#assertFence(tenant, run.runRef, fence);
    const finishedAt = this.#now();
    const resultBase = {
      identity: verificationRunIdentity(run),
      checkRef: check.checkRef,
      required: check.required,
      outcome:
        command.exitCode === 0 && !command.timedOut && !requiredArtifactMissing
          ? "passed"
          : "failed",
      durationMs: Math.max(0, Date.now() - started),
      startedAt,
      finishedAt,
      exitCode: command.exitCode,
      resultCode: command.timedOut
        ? "CHECK_TIMEOUT"
        : requiredArtifactMissing
          ? "REQUIRED_ARTIFACT_MISSING"
          : command.exitCode === 0
            ? "CHECK_PASSED"
            : "CHECK_FAILED",
      tool: check.tool,
      artifacts,
    } as const;
    const evidence = createCheckEvidence(
      { ...run, version: run.version + 1 },
      profile,
      resultBase,
    );
    const stored = await putVerifiedEvidence(
      this.#options.evidence,
      tenant,
      evidence,
    );
    await this.#assertFence(tenant, run.runRef, fence);
    const result: VerificationCheckResult = {
      ...resultBase,
      evidenceRef: stored.ref,
      evidenceDigest: stored.digest,
    };
    const next = await this.#options.store.saveCheckResult(
      tenant,
      run.runRef,
      run.version,
      run.attempt,
      result,
      fence,
      {
        type: "verification.check_completed",
        data: {
          identity: verificationRunIdentity(run),
          profile: {
            ref: profile.ref,
            version: profile.version,
            digest: profile.digest,
          },
          result,
        },
        createdAt: finishedAt,
        idempotencyKey: `check:${run.attempt}:${check.checkRef}`,
      },
    );
    if (next === undefined)
      throw new Error("verification fencing rejected check result");
    await this.#options.afterCheckpoint?.(result, next);
    return next;
  }

  #transition(
    tenant: VerificationTenant,
    run: VerificationRun,
    fence: number,
    state: "provisioning" | "running",
  ): Promise<VerificationRun> {
    return this.#mutate(
      tenant,
      run,
      fence,
      {
        state,
        ...(state === "running" && run.startedAt === undefined
          ? { startedAt: this.#now() }
          : {}),
      },
      `verification.${state}`,
      { identity: verificationRunIdentity(run) },
    );
  }

  async #mutate(
    tenant: VerificationTenant,
    run: VerificationRun,
    fence: number,
    mutation: Parameters<VerificationStore["mutateWithEvent"]>[3],
    type: string,
    data: unknown,
  ): Promise<VerificationRun> {
    const eventData = bindVerificationEventData(
      data,
      verificationRunIdentity(run),
    );
    const next = await this.#options.store.mutateWithEvent(
      tenant,
      run.runRef,
      run.version,
      mutation,
      {
        type,
        data: eventData,
        createdAt: this.#now(),
        idempotencyKey: `${type}:${run.attempt}:${run.version}`,
      },
      fence,
    );
    if (next === undefined)
      throw new Error("verification lease or fencing token was lost");
    return next;
  }

  async #assertFence(
    tenant: VerificationTenant,
    runRef: string,
    fence: number,
  ): Promise<void> {
    if (!(await this.#options.store.assertFence(tenant, runRef, fence))) {
      throw new Error("verification lease or fencing token was lost");
    }
  }

  async #publishArtifact(
    tenant: VerificationTenant,
    runRef: string,
    fence: number,
    kind: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<VerificationArtifact> {
    await this.#assertFence(tenant, runRef, fence);
    const artifact = await this.#options.artifacts.put(
      tenant,
      runRef,
      kind,
      mediaType,
      content,
    );
    parseArtifactReference(artifact.ref);
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (
      artifact.digest !== digest ||
      artifact.kind !== kind ||
      artifact.mediaType !== mediaType ||
      artifact.size !== content.byteLength
    ) {
      throw new Error("verification artifact store identity mismatch");
    }
    return artifact;
  }
}

function requiredVerdict(
  run: VerificationRun,
  profile: TrustedVerificationProfile,
  checks: readonly VerificationCheckResult[],
): Omit<VerificationVerdict, "evidenceRef" | "evidenceDigest"> {
  const requiredChecks = profile.checks
    .filter((check) => check.required)
    .map((check) => check.checkRef);
  const passedRequiredChecks = requiredChecks.filter(
    (ref) =>
      checks.find((check) => check.checkRef === ref)?.outcome === "passed",
  );
  const failedRequiredChecks = requiredChecks.filter(
    (ref) => !passedRequiredChecks.includes(ref),
  );
  return {
    identity: verificationRunIdentity(run),
    outcome: failedRequiredChecks.length === 0 ? "passed" : "failed",
    requiredChecks,
    passedRequiredChecks,
    failedRequiredChecks,
  };
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("budget")) return "PROFILE_BUDGET_EXCEEDED";
  if (message.includes("profile")) return "PROFILE_RESOLUTION_FAILED";
  if (message.includes("source bundle") || message.includes("source path")) {
    return "SOURCE_BUNDLE_INVALID";
  }
  if (message.includes("sandbox")) return "SANDBOX_FAILED";
  return "VERIFICATION_INFRASTRUCTURE_FAILURE";
}
