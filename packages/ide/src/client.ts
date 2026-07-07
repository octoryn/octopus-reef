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
): Promise<string> {
  const res = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, ...(secret ? { secret } : {}) }),
  });
  if (!res.ok) {
    throw new Error(`daemon returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as CreateSessionResponse;
  return body.id;
}

/**
 * Stream a session's evidence to `onEvent` until it seals (or `signal` aborts).
 * Reads the SSE body off `fetch` — no EventSource needed in the extension host.
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = drainSSE(buffer, onEvent);
  }
}
