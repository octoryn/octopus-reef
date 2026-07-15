#!/usr/bin/env node
/**
 * `reef-serve` — start the Reef daemon.
 *
 *   reef-serve [--port <n>] [--host <h>] [--persist <dir>] [--static <dir>]
 *
 * Offline and keyless by default (the mock driver), so the Docker image serves
 * a working governed backend — and, with --static, the web UI — the moment it
 * starts.
 */
import { ReefServer, type ReefServerOptions } from "./server.js";
import type { ReefEdition } from "@octopus-reef/protocol";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const port = Number(arg("--port") ?? process.env.PORT ?? 4300);
  const host = arg("--host") ?? process.env.HOST ?? "127.0.0.1";
  const persistDir = arg("--persist");
  const staticDir = arg("--static") ?? process.env.REEF_STATIC;
  const edition: ReefEdition =
    process.env.REEF_EDITION === "commercial" ? "commercial" : "community";
  const options: ReefServerOptions = {
    ...(persistDir !== undefined ? { persistDir } : {}),
    ...(staticDir !== undefined ? { staticDir } : {}),
    edition,
  };
  const server = new ReefServer(options);
  const bound = await server.listen(port, host);
  process.stdout.write(
    `reef server listening on http://${host}:${bound}\n` +
      `  POST /sessions · GET /sessions/:id/events · GET /sessions/:id/verify\n`,
  );
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
