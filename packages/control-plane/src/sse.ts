import type { RunEvent } from "./types.js";

/** Encode one event with a reconnect-safe SSE id/cursor. */
export function encodeSseEvent(event: RunEvent): string {
  return [
    `id: ${event.cursor}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}

export function encodeSseBatch(events: readonly RunEvent[]): string {
  return events.map(encodeSseEvent).join("");
}

/** Browser EventSource uses Last-Event-ID; query cursor remains a portable fallback. */
export function resolveSseCursor(
  lastEventId: string | undefined,
  queryCursor: string | undefined,
): string {
  const value = lastEventId?.trim() || queryCursor?.trim() || "0";
  if (!/^\d+$/.test(value)) throw new Error("invalid SSE cursor");
  return value;
}
