import type { VerificationEvent } from "./types.js";

export function encodeVerificationSseEvent(event: VerificationEvent): string {
  return [
    `id: ${event.cursor}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}

export function encodeVerificationSseBatch(
  events: readonly VerificationEvent[],
): string {
  return events.map(encodeVerificationSseEvent).join("");
}

export function resolveVerificationSseCursor(
  lastEventId: string | undefined,
  queryCursor: string | undefined,
): string {
  const cursor = lastEventId?.trim() || queryCursor?.trim() || "0";
  if (!/^\d+$/.test(cursor)) throw new Error("event cursor must be decimal");
  return cursor;
}
