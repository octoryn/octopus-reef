import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlaneService } from "./service.js";
import { encodeSseBatch, resolveSseCursor } from "./sse.js";
import { isTerminal } from "./state-machine.js";
import type { CreateAgentRunRequest, TenantScope } from "./types.js";
import { InvalidRunRequestError } from "./validation.js";
import { RunNotFoundError } from "./service.js";

export interface ControlPlaneHttpOptions {
  readonly pollMs?: number;
  readonly maxBodyBytes?: number;
}

/** Node HTTP handler for pause/resume/retry/cancel/review and cursor-based SSE. */
export function createControlPlaneHttpHandler(
  service: ControlPlaneService,
  options: ControlPlaneHttpOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response): void => {
    void route(service, request, response, options).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status =
        error instanceof RunNotFoundError
          ? 404
          : error instanceof InvalidRunRequestError
            ? 400
            : 409;
      json(response, status, {
        error: { code: errorCode(error), message: errorText(error) },
      });
    });
  };
}

async function route(
  service: ControlPlaneService,
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneHttpOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://control-plane.invalid");
  const path = url.pathname.split("/").filter(Boolean);
  if (path[0] !== "v1" || path[1] !== "runs") {
    json(response, 404, { error: "not found" });
    return;
  }
  const scope = tenantScope(request);
  if (request.method === "POST" && path.length === 2) {
    const body = await readJson(request, options.maxBodyBytes ?? 1_000_000);
    const run = await service.createRun(
      scope,
      body as unknown as CreateAgentRunRequest,
    );
    json(response, 202, run);
    return;
  }
  const runId = decodeURIComponent(path[2] ?? "");
  if (runId === "") {
    json(response, 404, { error: "run id is required" });
    return;
  }
  if (request.method === "GET" && path.length === 3) {
    json(response, 200, await service.getRun(scope, runId));
    return;
  }
  if (request.method === "GET" && path[3] === "events") {
    const cursor = resolveSseCursor(
      header(request, "last-event-id"),
      url.searchParams.get("cursor") ?? undefined,
    );
    if ((request.headers.accept ?? "").includes("text/event-stream")) {
      await streamEvents(
        service,
        scope,
        runId,
        cursor,
        response,
        options.pollMs ?? 750,
      );
      return;
    }
    json(response, 200, {
      events: await service.events(scope, runId, cursor),
    });
    return;
  }
  if (request.method !== "POST" || path.length !== 4) {
    json(response, 404, { error: "not found" });
    return;
  }
  const body = await readJson(request, options.maxBodyBytes ?? 1_000_000);
  const reason = stringField(body, "reason");
  const actorRef = stringField(body, "actorRef") ?? "operator";
  switch (path[3]) {
    case "pause":
      json(response, 200, await service.pause(scope, runId, reason, actorRef));
      return;
    case "resume":
      json(response, 200, await service.resume(scope, runId));
      return;
    case "retry":
      json(response, 200, await service.retry(scope, runId));
      return;
    case "cancel":
      json(response, 200, await service.cancel(scope, runId, reason));
      return;
    case "approve":
      json(
        response,
        200,
        await service.approve(scope, runId, actorRef, reason),
      );
      return;
    case "reject":
      json(response, 200, await service.reject(scope, runId, actorRef, reason));
      return;
    default:
      json(response, 404, { error: "not found" });
  }
}

async function streamEvents(
  service: ControlPlaneService,
  scope: TenantScope,
  runId: string,
  initialCursor: string,
  response: ServerResponse,
  pollMs: number,
): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  let cursor = initialCursor;
  while (!response.destroyed) {
    const events = await service.events(scope, runId, cursor, 250);
    if (events.length > 0) {
      response.write(encodeSseBatch(events));
      cursor = events.at(-1)!.cursor;
      continue;
    }
    const run = await service.getRun(scope, runId);
    if (isTerminal(run.status)) {
      response.end();
      return;
    }
    response.write(": keep-alive\n\n");
    await delay(pollMs);
  }
}

function tenantScope(request: IncomingMessage): TenantScope {
  const organisationId = header(request, "x-organisation-id");
  const projectId = header(request, "x-project-id");
  if (organisationId === undefined || projectId === undefined) {
    throw new InvalidRunRequestError(
      "x-organisation-id and x-project-id headers are required",
    );
  }
  return { organisationId, projectId };
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > maxBytes)
      throw new InvalidRunRequestError("request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidRunRequestError("request body must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRunRequestError("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function stringField(
  value: Record<string, unknown>,
  name: string,
): string | undefined {
  const field = value[name];
  return typeof field === "string" && field !== "" ? field : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof RunNotFoundError) return "RUN_NOT_FOUND";
  if (error instanceof InvalidRunRequestError) return "INVALID_RUN_REQUEST";
  return "RUN_CONFLICT";
}
