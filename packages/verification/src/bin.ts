#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { VerificationDispatchPublisher } from "./dispatch.js";
import { createVerificationHttpHandler } from "./http.js";
import { DeterministicSourceBundleMaterializer } from "./materializer.js";
import { PostgresVerificationStore } from "./adapters/postgres.js";
import {
  boolean,
  createProductionVerificationObjectStores,
  createProductionVerificationQueue,
  createProductionVerificationSandbox,
  createProductionVerificationSecrets,
  integer,
  loadVerificationWorkloadAuthenticator,
  loadTrustedVerificationProfiles,
  verificationPostgresConnectionFromEnvironment,
} from "./production.js";
import { VerificationService } from "./service.js";
import { DeterministicVerificationWorker } from "./worker.js";

const command = process.argv[2] ?? "api";
if (command === "help" || command === "--help") {
  process.stdout.write(
    "Usage: reef-verification [api|worker|migrate]\n" +
      "The API is /v1/verifications; AgentRun review routes are intentionally absent.\n",
  );
} else {
  await main(command);
}

async function main(selected: string): Promise<void> {
  if (selected === "api") return runApi();
  if (selected === "worker") return runWorker();
  if (selected === "migrate") {
    const store = new PostgresVerificationStore(
      verificationPostgresConnectionFromEnvironment(),
    );
    try {
      await store.migrate();
      process.stdout.write("verification migrations applied\n");
    } finally {
      await store.close();
    }
    return;
  }
  throw new Error(`unsupported verification command: ${selected}`);
}

async function runApi(): Promise<void> {
  const store = new PostgresVerificationStore(
    verificationPostgresConnectionFromEnvironment(),
  );
  if (boolean(process.env, "REEF_VERIFICATION_AUTO_MIGRATE", true))
    await store.migrate();
  const profiles = loadTrustedVerificationProfiles();
  const objects = createProductionVerificationObjectStores();
  const queue = createProductionVerificationQueue(store);
  const service = new VerificationService({
    store,
    evidence: objects.evidence,
    profiles,
  });
  const publisher = new VerificationDispatchPublisher({
    ownerId: `verification-api-${hostname()}-${randomUUID()}`,
    store,
    queue,
  });
  let draining = false;
  const drain = (): void => {
    if (draining) return;
    draining = true;
    void publisher
      .drainOnce()
      .catch((error: unknown) => {
        process.stderr.write(
          `verification dispatch failed: ${errorText(error)}\n`,
        );
      })
      .finally(() => {
        draining = false;
      });
  };
  drain();
  const timer = setInterval(
    drain,
    integer(process.env, "REEF_VERIFICATION_DISPATCH_POLL_MS", 250),
  );
  timer.unref();
  const handler = createVerificationHttpHandler(service, {
    readiness: () => store.ready(),
    workloadAuthenticator: loadVerificationWorkloadAuthenticator(),
  });
  const server = createServer(handler);
  const host = process.env["REEF_VERIFICATION_HOST"] ?? "0.0.0.0";
  const port = integer(process.env, "REEF_VERIFICATION_PORT", 8080);
  await listen(server, host, port);
  process.stdout.write(`reef verification API listening on ${host}:${port}\n`);
  await shutdown();
  clearInterval(timer);
  await close(server);
  await store.close();
}

async function runWorker(): Promise<void> {
  const store = new PostgresVerificationStore(
    verificationPostgresConnectionFromEnvironment(),
  );
  if (boolean(process.env, "REEF_VERIFICATION_AUTO_MIGRATE", false))
    await store.migrate();
  const profiles = loadTrustedVerificationProfiles();
  const objects = createProductionVerificationObjectStores();
  const worker = new DeterministicVerificationWorker({
    workerId:
      process.env["REEF_VERIFICATION_WORKER_ID"] ??
      `verification-worker-${hostname()}-${randomUUID()}`,
    store,
    queue: createProductionVerificationQueue(store),
    profiles,
    materializer: new DeterministicSourceBundleMaterializer({
      port: objects.materialization,
      maxFiles: integer(process.env, "REEF_VERIFICATION_MAX_FILES", 10_000),
      maxFileBytes: integer(
        process.env,
        "REEF_VERIFICATION_MAX_FILE_BYTES",
        16 * 1024 * 1024,
      ),
      maxTotalBytes: integer(
        process.env,
        "REEF_VERIFICATION_MAX_TOTAL_BYTES",
        128 * 1024 * 1024,
      ),
    }),
    sandboxes: createProductionVerificationSandbox(),
    artifacts: objects.artifacts,
    evidence: objects.evidence,
    secrets: createProductionVerificationSecrets(),
    leaseMs: integer(process.env, "REEF_VERIFICATION_LEASE_MS", 30_000),
    maxInfrastructureRetries: integer(
      process.env,
      "REEF_VERIFICATION_MAX_INFRASTRUCTURE_RETRIES",
      2,
    ),
    retryBaseMs: integer(process.env, "REEF_VERIFICATION_RETRY_BASE_MS", 1_000),
  });
  const once = boolean(process.env, "REEF_VERIFICATION_WORKER_ONCE", false);
  const pollMs = integer(process.env, "REEF_VERIFICATION_WORKER_POLL_MS", 250);
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });
  try {
    do {
      try {
        const worked = await worker.runOnce();
        if (!worked && !once) await delay(pollMs);
      } catch (error) {
        if (once) throw error;
        process.stderr.write(
          `verification worker iteration failed: ${errorText(error)}\n`,
        );
        await delay(pollMs);
      }
    } while (!once && !stopping);
  } finally {
    await store.close();
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) =>
    server.close((error) =>
      error === undefined ? resolveClose() : reject(error),
    ),
  );
}
function shutdown(): Promise<void> {
  return new Promise((resolveStop) => {
    process.once("SIGINT", resolveStop);
    process.once("SIGTERM", resolveStop);
  });
}
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
