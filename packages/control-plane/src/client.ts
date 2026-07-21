import type {
  AgentRun,
  CreateAgentRunRequest,
  RunEvent,
  TenantScope,
} from "./types.js";

export type DecimalCursor = `${bigint}`;

export interface ControlPlaneHttpClientOptions {
  readonly baseUrl: string;
  readonly tenant: TenantScope;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  /** Delay used after a clean or transiently failed SSE connection. */
  readonly reconnectDelayMs?: number;
}

export interface RunEventStreamOptions {
  readonly cursor?: DecimalCursor;
  readonly signal?: AbortSignal;
  /** Defaults to true. Terminal run events always end the iterator. */
  readonly reconnect?: boolean;
}

export interface RunReviewCommand {
  readonly idempotencyKey: string;
  readonly actorRef: string;
  readonly reason?: string;
}

export interface RunPauseCommand {
  readonly idempotencyKey: string;
  readonly actorRef?: string;
  readonly reason?: string;
}

export interface RunResumeCommand {
  readonly idempotencyKey: string;
}

export type RunRetryCommand = RunResumeCommand;

export interface RunCancelCommand {
  readonly idempotencyKey: string;
  readonly reason?: string;
}

export class ControlPlaneClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlPlaneClientError";
  }
}

export class ControlPlaneHttpError extends ControlPlaneClientError {
  constructor(
    readonly status: number,
    code: string,
    message: string,
    readonly responseBody: unknown,
  ) {
    super(message, code, status === 408 || status === 429 || status >= 500);
    this.name = "ControlPlaneHttpError";
  }
}

export class ControlPlaneNetworkError extends ControlPlaneClientError {
  constructor(message: string, cause: unknown) {
    super(message, "NETWORK_ERROR", true, { cause });
    this.name = "ControlPlaneNetworkError";
  }
}

export class ControlPlaneProtocolError extends ControlPlaneClientError {
  constructor(message: string, cause?: unknown) {
    super(message, "PROTOCOL_ERROR", false, { cause });
    this.name = "ControlPlaneProtocolError";
  }
}

/** Typed, server-side client for the deployment-neutral v1 Run API. */
export class ControlPlaneHttpClient {
  readonly #baseUrl: URL;
  readonly #tenant: TenantScope;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #reconnectDelayMs: number;

  constructor(options: ControlPlaneHttpClientOptions) {
    this.#baseUrl = baseUrl(options.baseUrl);
    this.#tenant = options.tenant;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#headers = options.headers ?? {};
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 750;
  }

  createRun(request: CreateAgentRunRequest): Promise<AgentRun> {
    return this.#json<AgentRun>(
      "POST",
      "v1/runs",
      request,
      request.idempotencyKey,
    );
  }

  getRun(runId: string): Promise<AgentRun> {
    return this.#json<AgentRun>("GET", `v1/runs/${segment(runId)}`);
  }

  pause(runId: string, command: RunPauseCommand): Promise<AgentRun> {
    return this.#json<AgentRun>(
      "POST",
      `v1/runs/${segment(runId)}/pause`,
      command,
      command.idempotencyKey,
    );
  }

  resume(runId: string, command: RunResumeCommand): Promise<AgentRun> {
    return this.#json<AgentRun>(
      "POST",
      `v1/runs/${segment(runId)}/resume`,
      command,
      command.idempotencyKey,
    );
  }

  cancel(runId: string, command: RunCancelCommand): Promise<AgentRun> {
    return this.#json<AgentRun>(
      "POST",
      `v1/runs/${segment(runId)}/cancel`,
      command,
      command.idempotencyKey,
    );
  }

  retry(runId: string, command: RunRetryCommand): Promise<AgentRun> {
    return this.#json<AgentRun>(
      "POST",
      `v1/runs/${segment(runId)}/retry`,
      command,
      command.idempotencyKey,
    );
  }

  approve(runId: string, command: RunReviewCommand): Promise<AgentRun> {
    return this.#json<AgentRun>(
      "POST",
      `v1/runs/${segment(runId)}/approve`,
      command,
      command.idempotencyKey,
    );
  }

  reject(runId: string, command: RunReviewCommand): Promise<AgentRun> {
    return this.#json<AgentRun>(
      "POST",
      `v1/runs/${segment(runId)}/reject`,
      command,
      command.idempotencyKey,
    );
  }

  async *streamEvents(
    runId: string,
    options: RunEventStreamOptions = {},
  ): AsyncIterable<RunEvent> {
    let cursor = options.cursor ?? "0";
    assertDecimalCursor(cursor);
    const reconnect = options.reconnect ?? true;
    while (!options.signal?.aborted) {
      let response: Response;
      try {
        response = await this.#fetch(
          this.#url(`v1/runs/${segment(runId)}/events`, { cursor }),
          {
            method: "GET",
            headers: this.#requestHeaders({
              Accept: "text/event-stream",
              "Last-Event-ID": cursor,
            }),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          },
        );
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect)
          throw new ControlPlaneNetworkError(
            "control-plane event stream failed",
            error,
          );
        await delay(this.#reconnectDelayMs, options.signal);
        continue;
      }
      if (!response.ok) throw await httpError(response);
      if (
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        throw new ControlPlaneProtocolError(
          "control-plane event stream returned a non-SSE response",
        );
      }
      if (response.body === null) {
        throw new ControlPlaneProtocolError(
          "control-plane event stream has no response body",
        );
      }
      let terminal = false;
      try {
        for await (const event of decodeSse(response.body)) {
          assertDecimalCursor(event.cursor);
          if (BigInt(event.cursor) <= BigInt(cursor)) continue;
          cursor = event.cursor as DecimalCursor;
          yield event;
          if (TERMINAL_EVENT_TYPES.has(event.type)) terminal = true;
        }
      } catch (error) {
        if (options.signal?.aborted) return;
        if (error instanceof ControlPlaneProtocolError) throw error;
        if (!reconnect)
          throw new ControlPlaneNetworkError(
            "control-plane event stream was interrupted",
            error,
          );
      }
      if (terminal || !reconnect) return;
      await delay(this.#reconnectDelayMs, options.signal);
    }
  }

  async #json<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url(path), {
        method,
        headers: this.#requestHeaders({
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey !== undefined
            ? { "Idempotency-Key": idempotencyKey }
            : {}),
        }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new ControlPlaneNetworkError(
        `control-plane ${method} request failed`,
        error,
      );
    }
    if (!response.ok) throw await httpError(response);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ControlPlaneProtocolError(
        "control-plane returned invalid JSON",
        error,
      );
    }
  }

  #requestHeaders(extra: Readonly<Record<string, string>>): Headers {
    const headers = new Headers(this.#headers);
    headers.set("x-organisation-id", this.#tenant.organisationId);
    headers.set("x-project-id", this.#tenant.projectId);
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return headers;
  }

  #url(path: string, query?: Readonly<Record<string, string>>): URL {
    const url = new URL(path, this.#baseUrl);
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, value);
    }
    return url;
  }
}

const TERMINAL_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.budget_exceeded",
]);

async function* decodeSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<RunEvent> {
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
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);
        if (event !== undefined) yield event;
        boundary = buffer.indexOf("\n\n");
      }
      if (chunk.done) break;
    }
    if (buffer.trim() !== "" && !buffer.trimStart().startsWith(":")) {
      throw new ControlPlaneProtocolError("truncated SSE frame");
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): RunEvent | undefined {
  if (frame === "") return undefined;
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
  assertDecimalCursor(id ?? "");
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch (error) {
    throw new ControlPlaneProtocolError(
      "SSE event data is invalid JSON",
      error,
    );
  }
  if (value === null || typeof value !== "object") {
    throw new ControlPlaneProtocolError("SSE event data must be an object");
  }
  const event = value as Partial<RunEvent>;
  if (event.cursor !== id || typeof event.type !== "string") {
    throw new ControlPlaneProtocolError(
      "SSE id/cursor or event type does not match its payload",
    );
  }
  if (type !== undefined && type !== event.type) {
    throw new ControlPlaneProtocolError(
      "SSE event name does not match its payload",
    );
  }
  return event as RunEvent;
}

async function httpError(response: Response): Promise<ControlPlaneHttpError> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    // Preserve non-JSON error bodies for diagnostics.
  }
  const details = errorDetails(body);
  return new ControlPlaneHttpError(
    response.status,
    details.code ?? `HTTP_${response.status}`,
    details.message ??
      `control-plane request failed with HTTP ${response.status}`,
    body,
  );
}

function errorDetails(body: unknown): {
  readonly code?: string;
  readonly message?: string;
} {
  if (body === null || typeof body !== "object" || !("error" in body))
    return {};
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return { message: error };
  if (error === null || typeof error !== "object") return {};
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
    ...(typeof record["message"] === "string"
      ? { message: record["message"] }
      : {}),
  };
}

function baseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("control-plane baseUrl must use http or https");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function segment(value: string): string {
  if (value === "") throw new TypeError("runId must not be empty");
  return encodeURIComponent(value);
}

function assertDecimalCursor(value: string): asserts value is DecimalCursor {
  if (!/^\d+$/.test(value)) {
    throw new ControlPlaneProtocolError("event cursor must be decimal");
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
