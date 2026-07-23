import type {
  VerificationEvent,
  VerificationEvidenceEnvelope,
  VerificationRun,
  VerificationRunRequest,
  VerificationTenant,
} from "./types.js";
import {
  assertSameIdentity,
  parseVerificationEvidenceResponse,
  parseVerificationEventResponse,
  parseVerificationRunResponse,
  verificationEventIdentity,
} from "./client-schema.js";
import { parseVerificationRunRequest } from "./validation.js";
import {
  compareVerificationDecimalCursors,
  parseVerificationDecimalCursor,
  type VerificationDecimalCursor,
} from "./cursor.js";

export type { VerificationDecimalCursor } from "./cursor.js";

export interface VerificationHttpClientOptions {
  readonly baseUrl: string;
  readonly tenant: VerificationTenant;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly reconnectDelayMs?: number;
}

export interface VerificationEventStreamOptions {
  readonly cursor?: VerificationDecimalCursor;
  readonly signal?: AbortSignal;
  readonly reconnect?: boolean;
}

export interface VerificationCommand {
  readonly idempotencyKey: string;
}

export class VerificationClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VerificationClientError";
  }
}

export class VerificationHttpError extends VerificationClientError {
  constructor(
    readonly status: number,
    code: string,
    message: string,
    readonly responseBody: unknown,
    retryable = status === 408 || status === 429 || status >= 500,
  ) {
    super(message, code, retryable);
    this.name = "VerificationHttpError";
  }
}

export class VerificationNetworkError extends VerificationClientError {
  constructor(message: string, cause: unknown) {
    super(message, "NETWORK_ERROR", true, { cause });
    this.name = "VerificationNetworkError";
  }
}

export class VerificationProtocolError extends VerificationClientError {
  constructor(message: string, cause?: unknown) {
    super(message, "PROTOCOL_ERROR", false, { cause });
    this.name = "VerificationProtocolError";
  }
}

/** Deployment-neutral, server-side client for the independent verification v1 API. */
export class VerificationHttpClient {
  readonly #baseUrl: URL;
  readonly #tenant: VerificationTenant;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #reconnectDelayMs: number;

  constructor(options: VerificationHttpClientOptions) {
    this.#baseUrl = baseUrl(options.baseUrl);
    this.#tenant = options.tenant;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#headers = options.headers ?? {};
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 750;
  }

  async createRun(request: VerificationRunRequest): Promise<VerificationRun> {
    const validated = parseProtocol(
      request,
      parseVerificationRunRequest,
      "verification create request",
    );
    assertTenant(validated, this.#tenant);
    const run = parseProtocol(
      await this.#json(
        "POST",
        "v1/verifications",
        validated,
        validated.idempotencyKey,
      ),
      parseVerificationRunResponse,
      "verification create response",
    );
    assertRunIdentity(run, validated);
    return run;
  }

  async getRun(runRef: string): Promise<VerificationRun> {
    const run = parseProtocol(
      await this.#json("GET", `v1/verifications/${segment(runRef)}`),
      parseVerificationRunResponse,
      "verification get response",
    );
    if (run.runRef !== runRef)
      throw new VerificationProtocolError("verification run identity mismatch");
    assertTenant(run, this.#tenant);
    return run;
  }

  async retryRun(
    runRef: string,
    command: VerificationCommand,
  ): Promise<VerificationRun> {
    return this.#command(runRef, "retry", command);
  }

  async cancelRun(
    runRef: string,
    command: VerificationCommand,
  ): Promise<VerificationRun> {
    return this.#command(runRef, "cancel", command);
  }

  async resolveEvidence(ref: string): Promise<VerificationEvidenceEnvelope> {
    const envelope = parseProtocol(
      await this.#json("GET", `v1/verification-evidence/${segment(ref)}`),
      parseVerificationEvidenceResponse,
      "verification Evidence response",
    );
    assertTenant(envelope, this.#tenant);
    if (envelope.ref !== ref)
      throw new VerificationProtocolError("Evidence identity echo mismatch");
    return envelope;
  }

  async *streamRunEvents(
    runRef: string,
    options: VerificationEventStreamOptions = {},
  ): AsyncIterable<VerificationEvent> {
    let cursor = parseClientCursor(
      options.cursor === undefined ? "0" : options.cursor,
    );
    const reconnect = options.reconnect ?? true;
    let expectedRun = await this.getRun(runRef);
    if (
      isTerminalRun(expectedRun) &&
      compareVerificationDecimalCursors(cursor, expectedRun.eventCursor) >= 0
    )
      return;
    while (!options.signal?.aborted) {
      let response: Response;
      try {
        response = await this.#fetch(
          this.#url(`v1/verifications/${segment(runRef)}/events`, { cursor }),
          {
            method: "GET",
            headers: this.#requestHeaders({
              Accept: "text/event-stream",
              "Last-Event-ID": cursor,
            }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect)
          throw new VerificationNetworkError(
            "verification event stream failed",
            error,
          );
        await delay(this.#reconnectDelayMs, options.signal);
        continue;
      }
      if (!response.ok) throw await httpError(response);
      if (
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        throw new VerificationProtocolError(
          "verification event stream returned non-SSE content",
        );
      }
      if (response.body === null)
        throw new VerificationProtocolError("verification SSE body is missing");
      let terminal = false;
      try {
        for await (const event of decodeSse(response.body)) {
          const eventCursor = parseClientCursor(event.cursor);
          if (compareVerificationDecimalCursors(eventCursor, cursor) <= 0)
            continue;
          if (event.runRef !== runRef)
            throw new VerificationProtocolError("SSE run identity mismatch");
          assertTenant(event, this.#tenant);
          try {
            assertSameIdentity(
              verificationEventIdentity(event),
              expectedRun,
              "verification SSE identity",
            );
          } catch (error) {
            throw new VerificationProtocolError(
              "verification SSE identity binding failed",
              error,
            );
          }
          cursor = eventCursor;
          yield event;
          if (TERMINAL_EVENTS.has(event.type)) terminal = true;
        }
      } catch (error) {
        if (options.signal?.aborted) return;
        if (error instanceof VerificationProtocolError) throw error;
        if (!reconnect)
          throw new VerificationNetworkError(
            "verification event stream interrupted",
            error,
          );
      }
      if (terminal || !reconnect) return;
      expectedRun = await this.getRun(runRef);
      if (isTerminalRun(expectedRun)) {
        const comparison = compareVerificationDecimalCursors(
          cursor,
          expectedRun.eventCursor,
        );
        if (comparison === 0) return;
        if (comparison > 0) {
          throw new VerificationProtocolError(
            "SSE cursor is ahead of the terminal verification run",
          );
        }
      }
      await delay(this.#reconnectDelayMs, options.signal);
    }
  }

  /** @deprecated Use createRun. Kept for compatibility with 0.2.0 prerelease clients. */
  createVerification(
    request: VerificationRunRequest,
  ): Promise<VerificationRun> {
    return this.createRun(request);
  }

  /** @deprecated Use getRun. Kept for compatibility with 0.2.0 prerelease clients. */
  getVerification(runRef: string): Promise<VerificationRun> {
    return this.getRun(runRef);
  }

  /** @deprecated Use retryRun. Kept for compatibility with 0.2.0 prerelease clients. */
  retryVerification(
    runRef: string,
    command: VerificationCommand,
  ): Promise<VerificationRun> {
    return this.retryRun(runRef, command);
  }

  /** @deprecated Use cancelRun. Kept for compatibility with 0.2.0 prerelease clients. */
  cancelVerification(
    runRef: string,
    command: VerificationCommand,
  ): Promise<VerificationRun> {
    return this.cancelRun(runRef, command);
  }

  /** @deprecated Use streamRunEvents. Kept for compatibility with 0.2.0 prerelease clients. */
  streamEvents(
    runRef: string,
    options: VerificationEventStreamOptions = {},
  ): AsyncIterable<VerificationEvent> {
    return this.streamRunEvents(runRef, options);
  }

  async #command(
    runRef: string,
    action: "retry" | "cancel",
    command: VerificationCommand,
  ): Promise<VerificationRun> {
    const run = parseProtocol(
      await this.#json(
        "POST",
        `v1/verifications/${segment(runRef)}/${action}`,
        command,
        command.idempotencyKey,
      ),
      parseVerificationRunResponse,
      `verification ${action} response`,
    );
    if (run.runRef !== runRef)
      throw new VerificationProtocolError("verification run identity mismatch");
    assertTenant(run, this.#tenant);
    return run;
  }

  async #json(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url(path), {
        method,
        headers: this.#requestHeaders({
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(key === undefined ? {} : { "Idempotency-Key": key }),
        }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new VerificationNetworkError(
        `verification ${method} request failed`,
        error,
      );
    }
    if (!response.ok) throw await httpError(response);
    try {
      return await response.json();
    } catch (error) {
      throw new VerificationProtocolError(
        "verification API returned invalid JSON",
        error,
      );
    }
  }

  #requestHeaders(extra: Readonly<Record<string, string>>): Headers {
    const headers = new Headers(this.#headers);
    headers.set("x-organisation-ref", this.#tenant.organisationRef);
    headers.set("x-project-ref", this.#tenant.projectRef);
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return headers;
  }

  #url(path: string, query?: Readonly<Record<string, string>>): URL {
    const url = new URL(path, this.#baseUrl);
    for (const [name, value] of Object.entries(query ?? {}))
      url.searchParams.set(name, value);
    return url;
  }
}

const TERMINAL_EVENTS = new Set([
  "verification.completed",
  "verification.failed",
  "verification.cancelled",
]);

async function* decodeSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<VerificationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = parseSseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame !== undefined) yield frame;
        boundary = buffer.indexOf("\n\n");
      }
      if (chunk.done) break;
    }
    if (buffer.trim() !== "" && !buffer.trimStart().startsWith(":")) {
      throw new VerificationProtocolError("truncated verification SSE frame");
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): VerificationEvent | undefined {
  let id: string | undefined;
  let type: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  parseClientCursor(id ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch (error) {
    throw new VerificationProtocolError(
      "verification SSE data is invalid JSON",
      error,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new VerificationProtocolError(
      "verification SSE data must be an object",
    );
  }
  const event = parsed as Partial<VerificationEvent>;
  if (
    event.cursor !== id ||
    event.type !== type ||
    typeof event.type !== "string"
  ) {
    throw new VerificationProtocolError(
      "verification SSE id, cursor, or type mismatch",
    );
  }
  return parseProtocol(
    event,
    parseVerificationEventResponse,
    "verification SSE event",
  );
}

async function httpError(response: Response): Promise<VerificationHttpError> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    /* retain text */
  }
  const details = errorDetails(body);
  return new VerificationHttpError(
    response.status,
    details.code ?? `HTTP_${response.status}`,
    details.message ??
      `verification request failed with HTTP ${response.status}`,
    body,
    details.retryable ??
      (response.status === 408 ||
        response.status === 429 ||
        response.status >= 500),
  );
}

function errorDetails(body: unknown): {
  code?: string;
  message?: string;
  retryable?: boolean;
} {
  if (body === null || typeof body !== "object" || !("error" in body))
    return {};
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return {};
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
    ...(typeof record["message"] === "string"
      ? { message: record["message"] }
      : {}),
    ...(typeof record["retryable"] === "boolean"
      ? { retryable: record["retryable"] }
      : {}),
  };
}

function baseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("verification baseUrl must use http or https");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function segment(value: string): string {
  if (value === "") throw new TypeError("opaque reference must not be empty");
  return encodeURIComponent(value);
}

function parseClientCursor(value: unknown): VerificationDecimalCursor {
  try {
    return parseVerificationDecimalCursor(value);
  } catch (error) {
    throw new VerificationProtocolError(
      "event cursor must be canonical decimal",
      error,
    );
  }
}

function assertTenant(
  value: VerificationTenant,
  expected: VerificationTenant,
): void {
  if (
    value.organisationRef !== expected.organisationRef ||
    value.projectRef !== expected.projectRef
  )
    throw new VerificationProtocolError(
      "verification tenant identity echo mismatch",
    );
}

function assertRunIdentity(
  run: VerificationRun,
  request: VerificationRunRequest,
): void {
  for (const key of IDENTITY_KEYS) {
    if (run[key] !== request[key])
      throw new VerificationProtocolError(
        `verification identity mismatch: ${key}`,
      );
  }
}

const IDENTITY_KEYS = [
  "organisationRef",
  "projectRef",
  "candidateRef",
  "candidateDigest",
  "sourceBundleRef",
  "sourceBundleDigest",
  "verificationProfileRef",
  "verificationProfileVersion",
  "verificationProfileDigest",
] as const;

function isTerminalRun(run: VerificationRun): boolean {
  return (
    run.state === "completed" ||
    run.state === "failed" ||
    run.state === "cancelled"
  );
}

function parseProtocol<T>(
  value: unknown,
  parse: (input: unknown) => T,
  name: string,
): T {
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof VerificationProtocolError) throw error;
    throw new VerificationProtocolError(
      `${name} failed runtime schema validation`,
      error,
    );
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
