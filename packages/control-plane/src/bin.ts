#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { KernelProofAcceptanceVerifier } from "./acceptance.js";
import { RunDispatchPublisher } from "./dispatch.js";
import { createControlPlaneHttpHandler } from "./http.js";
import {
  boolean,
  createProductionArtifacts,
  createProductionGit,
  createProductionKernel,
  createProductionQueue,
  createProductionSandbox,
  createProductionSecrets,
  integer,
  postgresConnectionFromEnvironment,
} from "./production.js";
import { ControlPlaneService } from "./service.js";
import { ControlPlaneWorker } from "./worker.js";
import {
  PostgresControlPlaneStore,
  PostgresDispatchOutbox,
  PostgresHumanReviewGateway,
} from "./adapters/postgres.js";

const command = process.argv[2] ?? "api";

if (command === "--help" || command === "help") {
  process.stdout.write(
    "Usage: reef-control-plane [api|serve|worker|migrate]\n\n" +
      "Required: REEF_CONTROL_PLANE_DATABASE_URL\n" +
      "RDS TLS: REEF_CONTROL_PLANE_DATABASE_SSL_MODE=verify-full and " +
      "REEF_CONTROL_PLANE_DATABASE_CA_FILE or _CA_BASE64\n",
  );
  process.exit(0);
}

await main(command);

async function main(selected: string): Promise<void> {
  if (selected === "api" || selected === "serve") {
    await runApi();
    return;
  }
  if (selected === "worker") {
    await runWorker();
    return;
  }
  if (selected === "migrate") {
    const store = new PostgresControlPlaneStore(
      postgresConnectionFromEnvironment(),
    );
    try {
      await store.migrate();
      process.stdout.write("control-plane migrations applied\n");
    } finally {
      await store.close();
    }
    return;
  }
  throw new Error(`unsupported command: ${selected}`);
}

async function runApi(): Promise<void> {
  const connection = postgresConnectionFromEnvironment();
  const store = new PostgresControlPlaneStore(connection);
  const reviews = new PostgresHumanReviewGateway(connection);
  const dispatchOutbox = new PostgresDispatchOutbox(connection);
  const queue = createProductionQueue(store);
  if (boolean(process.env, "REEF_CONTROL_PLANE_AUTO_MIGRATE", true)) {
    await store.migrate();
  }
  const service = new ControlPlaneService({
    runs: store,
    events: store,
    queue,
    reviews,
    dispatch: store,
  });
  const publisher = new RunDispatchPublisher({
    ownerId: `api-${hostname()}-${randomUUID()}`,
    outbox: dispatchOutbox,
    queue,
  });
  let publisherRunning = false;
  const publish = (): void => {
    if (publisherRunning) return;
    publisherRunning = true;
    void publisher
      .drainOnce()
      .catch((error: unknown) => {
        process.stderr.write(`dispatch publisher error: ${errorText(error)}\n`);
      })
      .finally(() => {
        publisherRunning = false;
      });
  };
  publish();
  const publisherTimer = setInterval(
    publish,
    integer(process.env, "REEF_DISPATCH_POLL_MS", 250),
  );
  publisherTimer.unref();

  const controlPlane = createControlPlaneHttpHandler(service);
  const server = createServer((request, response): void => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, service: "reef-control-plane-api" }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/readyz") {
      void store
        .readiness()
        .then((readiness) => {
          response.writeHead(readiness.ready ? 200 : 503, {
            "Content-Type": "application/json",
          });
          response.end(JSON.stringify(readiness));
        })
        .catch((error: unknown) => {
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ready: false,
              retryable: true,
              error: errorText(error),
            }),
          );
        });
      return;
    }
    controlPlane(request, response);
  });
  const host = process.env["REEF_CONTROL_PLANE_HOST"] ?? "0.0.0.0";
  const port = portFromEnvironment("REEF_CONTROL_PLANE_PORT", 8080);
  await listen(server, host, port);
  process.stdout.write(`reef-control-plane API listening on ${host}:${port}\n`);

  await shutdownSignal();
  clearInterval(publisherTimer);
  await closeServer(server);
  await Promise.all([dispatchOutbox.close(), reviews.close(), store.close()]);
}

async function runWorker(): Promise<void> {
  const connection = postgresConnectionFromEnvironment();
  const store = new PostgresControlPlaneStore(connection);
  const reviews = new PostgresHumanReviewGateway(connection);
  if (boolean(process.env, "REEF_CONTROL_PLANE_AUTO_MIGRATE", false)) {
    await store.migrate();
  }
  const artifacts = createProductionArtifacts();
  const git = createProductionGit();
  const worker = new ControlPlaneWorker({
    workerId:
      process.env["REEF_WORKER_ID"] ?? `worker-${hostname()}-${randomUUID()}`,
    runs: store,
    events: store,
    checkpoints: store,
    queue: createProductionQueue(store),
    sandboxes: createProductionSandbox(),
    secrets: createProductionSecrets(),
    reviews,
    acceptance: new KernelProofAcceptanceVerifier(),
    kernel: createProductionKernel(),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(git !== undefined ? { git } : {}),
    leaseMs: integer(process.env, "REEF_WORKER_LEASE_MS", 30_000),
    maxInfrastructureRetries: integer(
      process.env,
      "REEF_WORKER_MAX_INFRASTRUCTURE_RETRIES",
      5,
    ),
    retryBaseMs: integer(process.env, "REEF_WORKER_RETRY_BASE_MS", 1_000),
  });
  const once = boolean(process.env, "REEF_WORKER_ONCE", false);
  const pollMs = integer(process.env, "REEF_WORKER_POLL_MS", 250);
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      try {
        const worked = await worker.runOnce();
        if (!worked && !once) await delay(pollMs);
      } catch (error) {
        if (once) throw error;
        process.stderr.write(`worker iteration failed: ${errorText(error)}\n`);
        await delay(pollMs);
      }
    } while (!once && !stopping);
  } finally {
    await Promise.all([reviews.close(), store.close()]);
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function shutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function portFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
