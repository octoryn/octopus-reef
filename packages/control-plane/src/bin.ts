#!/usr/bin/env node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createControlPlaneHttpHandler } from "./http.js";
import { ControlPlaneService } from "./service.js";
import {
  PostgresControlPlaneStore,
  PostgresHumanReviewGateway,
} from "./adapters/postgres.js";

const command = process.argv[2] ?? "serve";

if (command === "--help" || command === "help") {
  process.stdout.write(`Usage: reef-control-plane [serve|migrate]\n\n`);
  process.stdout.write(
    "Required: REEF_CONTROL_PLANE_DATABASE_URL\n" +
      "Optional: REEF_CONTROL_PLANE_HOST (0.0.0.0), " +
      "REEF_CONTROL_PLANE_PORT (8080), REEF_CONTROL_PLANE_AUTO_MIGRATE (true)\n",
  );
  process.exit(0);
}

await main(command);

async function main(selected: string): Promise<void> {
  const databaseUrl = requiredEnvironment("REEF_CONTROL_PLANE_DATABASE_URL");
  const store = new PostgresControlPlaneStore(databaseUrl);
  const reviews = new PostgresHumanReviewGateway(databaseUrl);
  let closing = false;

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.all([store.close(), reviews.close()]);
  };

  try {
    if (selected === "migrate") {
      await store.migrate();
      process.stdout.write("control-plane migrations applied\n");
      return;
    }
    if (selected !== "serve") {
      throw new Error(`unsupported command: ${selected}`);
    }
    if (environmentBoolean("REEF_CONTROL_PLANE_AUTO_MIGRATE", true)) {
      await store.migrate();
    }
    const service = new ControlPlaneService({
      runs: store,
      events: store,
      queue: store,
      reviews,
    });
    const controlPlane = createControlPlaneHttpHandler(service);
    const server = createServer(
      (request: IncomingMessage, response: ServerResponse): void => {
        if (request.method === "GET" && request.url === "/healthz") {
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          response.end(
            JSON.stringify({ ok: true, service: "reef-control-plane" }),
          );
          return;
        }
        controlPlane(request, response);
      },
    );
    const host = process.env["REEF_CONTROL_PLANE_HOST"] ?? "0.0.0.0";
    const port = environmentPort("REEF_CONTROL_PLANE_PORT", 8080);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    process.stdout.write(
      `reef-control-plane listening on http://${host}:${port}\n`,
    );

    const stop = (): void => {
      server.close(() => {
        void close().finally(() => process.exit(0));
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    await close();
    throw error;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function environmentBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function environmentPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return port;
}
