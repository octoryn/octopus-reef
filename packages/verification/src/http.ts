import type { IncomingMessage, ServerResponse } from "node:http";
import {
  InvalidVerificationRequestError,
  VerificationConflictError,
  VerificationInfrastructureError,
  VerificationNotFoundError,
  verificationInfrastructureStatus,
} from "./errors.js";
import type { VerificationService } from "./service.js";
import { encodeVerificationSseBatch, resolveVerificationSseCursor } from "./sse.js";
import type { VerificationRunRequest, VerificationTenant } from "./types.js";

export interface VerificationHttpOptions {
  readonly pollMs?: number;
  readonly maxBodyBytes?: number;
  readonly readiness?: () => Promise<void>;
}

export function createVerificationHttpHandler(
  service: VerificationService,
  options: VerificationHttpOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response): void => {
    void route(service, request, response, options).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = errorStatus(error);
      json(response, status, {
        error: {
          code: errorCode(error, status),
          message: errorMessage(error, status),
          retryable: status === 500 || status === 503,
        },
      });
    });
  };
}

async function route(
  service: VerificationService,
  request: IncomingMessage,
  response: ServerResponse,
  options: VerificationHttpOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://verification.invalid");
  const path = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/health/live") {
    json(response, 200, { status: "live" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/health/ready") {
    await options.readiness?.();
    json(response, 200, { status: "ready" });
    return;
  }
  const tenant = tenantHeaders(request);
  if (request.method === "GET" && path[0] === "v1" && path[1] === "verification-evidence") {
    if (path.length !== 3) return notFound(response);
    const ref = decode(path[2]!);
    const envelope = await service.resolveEvidence(tenant, ref);
    if (envelope === undefined) throw new VerificationNotFoundError("verification Evidence not found");
    json(response, 200, envelope);
    return;
  }
  if (path[0] !== "v1" || path[1] !== "verifications") return notFound(response);
  if (request.method === "POST" && path.length === 2) {
    const body = await readJson(request, options.maxBodyBytes ?? 256_000);
    assertIdempotencyHeader(request, body);
    json(response, 202, await service.createRun(tenant, body as unknown as VerificationRunRequest));
    return;
  }
  if (path.length < 3) return notFound(response);
  const runRef = decode(path[2]!);
  if (request.method === "GET" && path.length === 3) {
    json(response, 200, await service.getRun(tenant, runRef));
    return;
  }
  if (request.method === "GET" && path.length === 4 && path[3] === "events") {
    const cursor = resolveVerificationSseCursor(
      header(request, "last-event-id"),
      url.searchParams.get("cursor") ?? undefined,
    );
    if ((request.headers.accept ?? "").includes("text/event-stream")) {
      await streamEvents(service, tenant, runRef, cursor, response, options.pollMs ?? 750);
    } else {
      json(response, 200, { events: await service.events(tenant, runRef, cursor) });
    }
    return;
  }
  if (request.method !== "POST" || path.length !== 4) return notFound(response);
  const command = await readJson(request, options.maxBodyBytes ?? 256_000);
  assertIdempotencyHeader(request, command);
  if (path[3] === "retry") {
    json(response, 200, await service.retryRun(tenant, runRef, command as { idempotencyKey: string }));
    return;
  }
  if (path[3] === "cancel") {
    json(response, 200, await service.cancelRun(tenant, runRef, command as { idempotencyKey: string }));
    return;
  }
  return notFound(response);
}

async function streamEvents(
  service: VerificationService,
  tenant: VerificationTenant,
  runRef: string,
  initialCursor: string,
  response: ServerResponse,
  pollMs: number,
): Promise<void> {
  await service.getRun(tenant, runRef);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  let cursor = initialCursor;
  while (!response.destroyed) {
    const events = await service.events(tenant, runRef, cursor, 250);
    if (events.length > 0) {
      response.write(encodeVerificationSseBatch(events));
      cursor = events.at(-1)!.cursor;
      continue;
    }
    const run = await service.getRun(tenant, runRef);
    if (["completed", "failed", "cancelled"].includes(run.state)) {
      response.end();
      return;
    }
    response.write(": keep-alive\n\n");
    await delay(pollMs);
  }
}

function tenantHeaders(request: IncomingMessage): VerificationTenant {
  const organisationRef = header(request, "x-organisation-ref");
  const projectRef = header(request, "x-project-ref");
  if (
    organisationRef === undefined || projectRef === undefined ||
    organisationRef.length > 1024 || projectRef.length > 1024 ||
    !organisationRef.includes(":") || !projectRef.includes(":")
  ) {
    throw new InvalidVerificationRequestError(
      "bounded x-organisation-ref and x-project-ref headers are required",
    );
  }
  return { organisationRef, projectRef };
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new InvalidVerificationRequestError("request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("request body must be an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new InvalidVerificationRequestError(
      error instanceof Error ? error.message : "request body must be valid JSON",
      { cause: error },
    );
  }
}

function assertIdempotencyHeader(
  request: IncomingMessage,
  body: Record<string, unknown>,
): void {
  const headerKey = header(request, "idempotency-key");
  const bodyKey = body["idempotencyKey"];
  if (typeof bodyKey !== "string" || bodyKey === "" || bodyKey.length > 256) {
    throw new InvalidVerificationRequestError("idempotencyKey is required");
  }
  if (headerKey === undefined) {
    throw new InvalidVerificationRequestError("Idempotency-Key header is required");
  }
  if (headerKey !== bodyKey) throw new VerificationConflictError("idempotency header/body mismatch");
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function decode(value: string): string {
  try { return decodeURIComponent(value); }
  catch (error) { throw new InvalidVerificationRequestError("opaque reference is invalid", { cause: error }); }
}

function notFound(response: ServerResponse): void {
  json(response, 404, { error: { code: "NOT_FOUND", message: "not found", retryable: false } });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function errorStatus(error: unknown): number {
  if (error instanceof VerificationNotFoundError) return 404;
  if (error instanceof InvalidVerificationRequestError) return 400;
  if (error instanceof VerificationConflictError) return 409;
  return verificationInfrastructureStatus(error);
}

function errorCode(error: unknown, status: number): string {
  if (error instanceof VerificationNotFoundError) return "VERIFICATION_NOT_FOUND";
  if (error instanceof InvalidVerificationRequestError) return "INVALID_VERIFICATION_REQUEST";
  if (error instanceof VerificationConflictError) return "VERIFICATION_CONFLICT";
  if (error instanceof VerificationInfrastructureError) return error.code;
  return status === 503 ? "VERIFICATION_INFRASTRUCTURE_UNAVAILABLE" : "VERIFICATION_INFRASTRUCTURE_FAILURE";
}

function errorMessage(error: unknown, status: number): string {
  if (status < 500 || error instanceof VerificationInfrastructureError) {
    return error instanceof Error ? error.message : String(error);
  }
  return status === 503
    ? "verification infrastructure is temporarily unavailable"
    : "verification infrastructure request failed";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
