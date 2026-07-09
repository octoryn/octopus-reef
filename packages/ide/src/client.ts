/**
 * The Reef daemon client used by the VS Code extension host. Node has global
 * `fetch` but no `EventSource`, so we read the SSE stream off the fetch body
 * ourselves. The frame parsing is a pure function so it's testable without a
 * network or a browser.
 */
import type {
  CreateSessionResponse,
  ServerEvent,
} from "@octopus-reef/protocol";

export type { ServerEvent };

/**
 * Pull complete `data: …\n\n` SSE frames out of an accumulating buffer, invoking
 * `onFrame` for each parsed {@link ServerEvent}, and return the unconsumed tail.
 */
export function drainSSE(
  buffer: string,
  onFrame: (event: ServerEvent) => void,
): string {
  let rest = buffer;
  for (;;) {
    const brk = rest.indexOf("\n\n");
    if (brk < 0) break;
    const chunk = rest.slice(0, brk);
    rest = rest.slice(brk + 2);
    const line = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (line === undefined) continue;
    try {
      const obj: unknown = JSON.parse(line.slice(6));
      if (
        typeof obj === "object" &&
        obj !== null &&
        "type" in obj &&
        (obj.type === "hello" || obj.type === "event" || obj.type === "sealed")
      ) {
        onFrame(obj as ServerEvent);
      }
    } catch {
      /* ignore a malformed frame */
    }
  }
  return rest;
}

/** Start a governed session on the daemon; resolves with its id. */
export async function createSession(
  baseUrl: string,
  task: string,
  secret?: string,
  persist = false,
): Promise<string> {
  const res = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task,
      ...(secret ? { secret } : {}),
      ...(persist ? { persist: true } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`daemon returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as CreateSessionResponse;
  return body.id;
}

/** Re-verify a sealed session through the daemon. */
export async function verifySession(
  baseUrl: string,
  id: string,
): Promise<import("@octopus-reef/protocol").VerifyResult> {
  const res = await fetch(`${baseUrl}/sessions/${id}/verify`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`daemon returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as import("@octopus-reef/protocol").VerifyResult;
}

/** A single SSE frame (or the pending tail) must fit in this much memory. */
const MAX_BUFFER = 1_000_000;
/** Abort the stream if no bytes arrive for this long (a hung daemon). */
const IDLE_MS = 120_000;

async function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("event stream idle timeout")),
      ms,
    );
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Stream a session's evidence to `onEvent` until it seals (or `signal` aborts).
 * Reads the SSE body off `fetch` — no EventSource needed in the extension host.
 * Bounded: a delimiter-less flood can't grow memory without limit, and a hung
 * daemon trips the idle timeout instead of blocking forever.
 */
export async function streamEvents(
  baseUrl: string,
  id: string,
  onEvent: (event: ServerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${baseUrl}/sessions/${id}/events`, {
    headers: { accept: "text/event-stream" },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (res.body === null) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await readWithTimeout(reader, IDLE_MS);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainSSE(buffer, onEvent);
      if (buffer.length > MAX_BUFFER) {
        throw new Error("event stream exceeded the frame size limit");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
