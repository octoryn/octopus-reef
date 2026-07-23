import { InvalidVerificationRequestError } from "./errors.js";

const CANONICAL_DECIMAL_CURSOR = /^(?:0|[1-9][0-9]*)$/;

/**
 * A string-only decimal cursor. Runtime parsing additionally rejects negative
 * bigint spellings so the accepted language is exactly `0|[1-9][0-9]*`.
 */
export type VerificationDecimalCursor = `${bigint}`;

export function parseVerificationDecimalCursor(
  value: unknown,
  name = "event cursor",
): VerificationDecimalCursor {
  if (typeof value !== "string" || !CANONICAL_DECIMAL_CURSOR.test(value)) {
    throw new InvalidVerificationRequestError(
      `${name} must be 0 or a canonical non-negative ASCII decimal`,
    );
  }
  return value as VerificationDecimalCursor;
}

export function compareVerificationDecimalCursors(
  left: unknown,
  right: unknown,
): -1 | 0 | 1 {
  const canonicalLeft = parseVerificationDecimalCursor(left);
  const canonicalRight = parseVerificationDecimalCursor(right);
  const leftInteger = BigInt(canonicalLeft);
  const rightInteger = BigInt(canonicalRight);
  return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
}
