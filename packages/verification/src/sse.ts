import type { VerificationEvent } from "./types.js";
import {
  parseVerificationDecimalCursor,
  type VerificationDecimalCursor,
} from "./cursor.js";
import { InvalidVerificationRequestError } from "./errors.js";

export function encodeVerificationSseEvent(event: VerificationEvent): string {
  const cursor = parseVerificationDecimalCursor(event.cursor);
  return [
    `id: ${cursor}`,
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
): VerificationDecimalCursor {
  const headerCursor =
    lastEventId === undefined
      ? undefined
      : parseVerificationDecimalCursor(lastEventId, "Last-Event-ID");
  const urlCursor =
    queryCursor === undefined
      ? undefined
      : parseVerificationDecimalCursor(queryCursor, "cursor query parameter");
  if (
    headerCursor !== undefined &&
    urlCursor !== undefined &&
    headerCursor !== urlCursor
  ) {
    throw new InvalidVerificationRequestError(
      "Last-Event-ID and cursor query parameter must match",
    );
  }
  return headerCursor ?? urlCursor ?? parseVerificationDecimalCursor("0");
}
