/**
 * The Reef web client — a thin wrapper over the daemon's HTTP + SSE contract.
 * All wire shapes come from `@octopus-reef/protocol`, so the UI renders exactly
 * what the engine recorded.
 */
import type {
  CreateSessionResponse,
  ServerEvent,
  VerifyResult,
} from "@octopus-reef/protocol";

export type { ServerEvent, VerifyResult };

/** Parse+validate one SSE frame body into a typed {@link ServerEvent}. */
export function parseServerEvent(data: string): ServerEvent {
  const obj: unknown = JSON.parse(data);
  if (
    typeof obj === "object" &&
    obj !== null &&
    "type" in obj &&
    (obj.type === "hello" || obj.type === "event" || obj.type === "sealed")
  ) {
    return obj as ServerEvent;
  }
  throw new Error("unrecognized server event frame");
}

/** Start a governed session; resolves with its id. */
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
    const body: unknown = await res.json().catch(() => ({}));
    const msg =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : res.statusText;
    throw new Error(msg);
  }
  const body = (await res.json()) as CreateSessionResponse;
  return body.id;
}

export interface Subscription {
  close(): void;
}

/**
 * Subscribe to a session's live evidence stream. `onEvent` fires for every
 * frame (replayed + live); `onDone` fires when the stream ends (the session
 * sealed and the server closed the connection).
 */
export function subscribeEvents(
  baseUrl: string,
  id: string,
  onEvent: (event: ServerEvent) => void,
  onDone: () => void,
  onError: (reason: string) => void,
): Subscription {
  const source = new EventSource(`${baseUrl}/sessions/${id}/events`);
  let sealed = false;
  source.onmessage = (m: MessageEvent<string>) => {
    let frame: ServerEvent;
    try {
      frame = parseServerEvent(m.data);
    } catch {
      return;
    }
    if (frame.type === "sealed") sealed = true;
    onEvent(frame);
  };
  // The server ends the stream after sealing; EventSource surfaces the close as
  // an error and would otherwise auto-reconnect, so close it ourselves. If it
  // closes BEFORE sealing (the daemon died / the session hung), that's a real
  // failure — report it so the UI doesn't sit on "running" forever.
  source.onerror = () => {
    source.close();
    if (sealed) onDone();
    else onError("connection to the daemon was lost before the session sealed");
  };
  return { close: () => source.close() };
}
