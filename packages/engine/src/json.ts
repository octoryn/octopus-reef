/**
 * Runtime JSON validation — the boundary that keeps driver-supplied data honest.
 *
 * Driver steps carry arbitrary `data`. Canonical hashing (octopus-evidence)
 * requires genuine JSON: a `Date`, `undefined`, `BigInt`, `NaN`, a function, or
 * a cyclic object would either crash hashing or hash inconsistently. Rather than
 * cast (`as JsonObject`) and hope, we validate at the boundary and fail loudly.
 */
import type { JsonValue } from "octopus-evidence";

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * Deep-validate `value` as JSON, returning a canonical copy. Drops `undefined`
 * object properties (as `JSON.stringify` does). Throws {@link EngineError} on any
 * non-JSON value (non-finite number, function, symbol, bigint, Date/Map/etc.,
 * or a cycle).
 */
export function assertJson(
  value: unknown,
  path = "$",
  seen = new WeakSet<object>(),
): JsonValue {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value as string | boolean;
  if (t === "number") {
    if (!Number.isFinite(value))
      throw new EngineError(`non-finite number at ${path}`);
    return value as number;
  }
  if (t !== "object") {
    throw new EngineError(`non-JSON value of type ${t} at ${path}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new EngineError(`circular reference at ${path}`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((v, i) => assertJson(v, `${path}[${i}]`, seen));
    }
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new EngineError(
        `non-plain object (${obj.constructor?.name ?? "unknown"}) at ${path}`,
      );
    }
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      out[k] = assertJson(v, `${path}.${k}`, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Validate that `value` is a JSON object (not an array or primitive). */
export function assertJsonObject(
  value: unknown,
  path = "$",
): { readonly [key: string]: JsonValue } {
  const json = assertJson(value, path);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new EngineError(`expected a JSON object at ${path}`);
  }
  return json;
}
