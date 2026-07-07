/**
 * The web client's pure logic — SSE frame parsing — is testable without a
 * browser. EventSource wiring is thin and exercised via the running app.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServerEvent } from "../src/api.js";

test("web: parseServerEvent accepts the three frame types", () => {
  const hello = parseServerEvent(
    JSON.stringify({ type: "hello", id: "s", task: "t" }),
  );
  assert.equal(hello.type, "hello");

  const event = parseServerEvent(
    JSON.stringify({
      type: "event",
      event: { seq: 1, kind: "observation", summary: "x" },
    }),
  );
  assert.equal(event.type, "event");
  if (event.type === "event") assert.equal(event.event.seq, 1);

  const sealed = parseServerEvent(
    JSON.stringify({
      type: "sealed",
      snapshot: { outcome: "completed" },
      verify: { ok: true },
    }),
  );
  assert.equal(sealed.type, "sealed");
});

test("web: parseServerEvent rejects junk and unknown types", () => {
  assert.throws(() => parseServerEvent('{"type":"nope"}'));
  assert.throws(() => parseServerEvent("not json"));
  assert.throws(() => parseServerEvent("42"));
});
