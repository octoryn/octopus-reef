import { randomUUID } from "node:crypto";
import type {
  TrustedVerificationProfileRegistry,
  VerificationEvidenceStore,
  VerificationStore,
} from "./ports.js";
import type {
  VerificationEvent,
  VerificationEvidenceEnvelope,
  VerificationRun,
  VerificationRunRequest,
  VerificationTenant,
} from "./types.js";
import {
  InvalidVerificationRequestError,
  VerificationConflictError,
  VerificationNotFoundError,
} from "./errors.js";
import {
  assertTenantBinding,
  parseVerificationRunRequest,
} from "./validation.js";
import { resolveEvidenceEnvelope } from "./evidence.js";

export interface VerificationServiceOptions {
  readonly store: VerificationStore;
  readonly evidence: VerificationEvidenceStore;
  readonly profiles: TrustedVerificationProfileRegistry;
  readonly id?: () => string;
  readonly now?: () => string;
}

export interface VerificationIdempotentCommand {
  readonly idempotencyKey: string;
}

export class VerificationService {
  readonly #store: VerificationStore;
  readonly #evidence: VerificationEvidenceStore;
  readonly #profiles: TrustedVerificationProfileRegistry;
  readonly #id: () => string;
  readonly #now: () => string;

  constructor(options: VerificationServiceOptions) {
    this.#store = options.store;
    this.#evidence = options.evidence;
    this.#profiles = options.profiles;
    this.#id = options.id ?? (() => `verification:${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async createRun(
    tenant: VerificationTenant,
    input: VerificationRunRequest,
  ): Promise<VerificationRun> {
    const request = parseVerificationRunRequest(input);
    assertTenantBinding(tenant, request);
    await this.#profiles.resolve(request);
    const now = this.#now();
    const run: VerificationRun = {
      ...request,
      runRef: this.#id(),
      state: "queued",
      version: 1,
      attempt: 1,
      eventCursor: "0",
      createdAt: now,
      updatedAt: now,
      checks: [],
    };
    try {
      return (
        await this.#store.createAndDispatch(
          run,
          {
            type: "verification.queued",
            data: { identity: identity(run) },
            createdAt: now,
            idempotencyKey: `create:${run.idempotencyKey}`,
          },
          {
            idempotencyKey: `create:${run.idempotencyKey}`,
            attempt: 1,
            availableAt: now,
          },
        )
      ).run;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("idempotency key conflicts")
      ) {
        throw new VerificationConflictError(error.message);
      }
      throw error;
    }
  }

  async getRun(
    tenant: VerificationTenant,
    runRef: string,
  ): Promise<VerificationRun> {
    const run = await this.#store.get(tenant, runRef);
    if (run === undefined) throw new VerificationNotFoundError();
    return run;
  }

  async retryRun(
    tenant: VerificationTenant,
    runRef: string,
    command: VerificationIdempotentCommand,
  ): Promise<VerificationRun> {
    strictCommand(command);
    const current = await this.getRun(tenant, runRef);
    if (current.state === "queued") return current;
    if (current.state !== "failed" && current.state !== "cancelled") {
      throw new VerificationConflictError(
        "only operationally failed or cancelled verification runs may be retried",
      );
    }
    const now = this.#now();
    const next = await this.#store.mutateAndDispatch(
      tenant,
      runRef,
      current.version,
      {
        state: "queued",
        attempt: current.attempt + 1,
        checks: [],
        clearFailure: true,
        clearVerdict: true,
        clearLease: true,
      },
      {
        type: "verification.retried",
        data: { attempt: current.attempt + 1, identity: identity(current) },
        createdAt: now,
        idempotencyKey: `retry:${command.idempotencyKey}`,
      },
      {
        idempotencyKey: `retry:${command.idempotencyKey}`,
        attempt: current.attempt + 1,
        availableAt: now,
      },
    );
    if (next === undefined)
      throw new VerificationConflictError("verification changed concurrently");
    return next;
  }

  async cancelRun(
    tenant: VerificationTenant,
    runRef: string,
    command: VerificationIdempotentCommand,
  ): Promise<VerificationRun> {
    strictCommand(command);
    const current = await this.getRun(tenant, runRef);
    if (current.state === "cancelled") return current;
    if (["completed", "failed"].includes(current.state)) {
      throw new VerificationConflictError(
        "terminal verification run cannot be cancelled",
      );
    }
    const now = this.#now();
    const next = await this.#store.mutateWithEvent(
      tenant,
      runRef,
      current.version,
      { state: "cancelled", finishedAt: now, clearLease: true },
      {
        type: "verification.cancelled",
        data: { identity: identity(current) },
        createdAt: now,
        idempotencyKey: `cancel:${command.idempotencyKey}`,
      },
    );
    if (next === undefined)
      throw new VerificationConflictError("verification changed concurrently");
    return next;
  }

  async events(
    tenant: VerificationTenant,
    runRef: string,
    afterCursor = "0",
    limit = 100,
  ): Promise<readonly VerificationEvent[]> {
    if (!/^\d+$/.test(afterCursor))
      throw new Error("invalid decimal event cursor");
    await this.getRun(tenant, runRef);
    return this.#store.events(tenant, runRef, afterCursor, limit);
  }

  resolveEvidence(
    tenant: VerificationTenant,
    ref: string,
  ): Promise<VerificationEvidenceEnvelope | undefined> {
    if (!ref.startsWith("evidence:"))
      throw new Error("invalid opaque Evidence ref");
    return resolveEvidenceEnvelope(this.#evidence, tenant, ref);
  }
}

function strictCommand(value: VerificationIdempotentCommand): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).length !== 1 ||
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey.trim() === "" ||
    value.idempotencyKey.length > 256
  ) {
    throw new InvalidVerificationRequestError(
      "verification command must contain only idempotencyKey",
    );
  }
}

function identity(run: VerificationRun): Record<string, string> {
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
