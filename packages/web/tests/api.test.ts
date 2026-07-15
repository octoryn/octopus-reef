/**
 * The web client's pure logic — SSE frame parsing — is testable without a
 * browser. EventSource wiring is thin and exercised via the running app.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSession,
  parseServerEvent,
  tamperSession,
  verifySession,
} from "../src/api.js";

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

test("web: createSession can request persisted sessions for verify/tamper", async () => {
  const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
    [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push(
      init === undefined ? { url: String(url) } : { url: String(url), init },
    );
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: "sess-web" }),
    } as Response);
  }) as typeof fetch;
  try {
    const id = await createSession("", "C web run", { persist: true });
    assert.equal(id, "sess-web");
    assert.equal(calls[0]?.url, "/sessions");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      task: "C web run",
      persist: true,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("web: verifySession and tamperSession parse daemon proof results", async () => {
  const original = globalThis.fetch;
  const queue = [
    { ok: true, work: "intact", log: "intact", binding: "bound" },
    {
      tampered: true,
      artifact: "session.log.jsonl",
      offset: 0,
      verify: {
        ok: false,
        work: "unchecked",
        log: "broken: evidence 0 failed",
        binding: "unchecked",
      },
    },
  ];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const body = queue.shift();
    assert.ok(String(url).startsWith("/sessions/sess-web/"));
    if (String(url).endsWith("/tamper")) assert.equal(init?.method, "POST");
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch;
  try {
    const green = await verifySession("", "sess-web");
    assert.equal(green.ok, true);
    const red = await tamperSession("", "sess-web");
    assert.equal(red.tampered, true);
    assert.equal(red.verify.ok, false);
  } finally {
    globalThis.fetch = original;
  }
});
