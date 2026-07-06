import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernedSession,
  MockDriver,
  UnsafeDemoDriver,
  loadSession,
  persistSession,
  type ReefEvent,
} from "../src/index.js";

/** A deterministic clock so evidence ids are stable across runs. */
function fixedClock(baseSeconds = 0): () => string {
  let n = baseSeconds;
  return () => new Date(Date.UTC(2026, 6, 6, 0, 0, n++)).toISOString();
}

test("a governed session drives the work spine proposed → done", async () => {
  const session = new GovernedSession({
    id: "s1",
    task: "rotate the signing key",
    driver: new MockDriver(),
    now: fixedClock(),
  });
  const { snapshot } = await session.run();

  assert.equal(snapshot.workState, "done");
  assert.equal(snapshot.sealed, true);
  // proposed(create) + ready + claimed + in_progress + done = 5 work-chain links.
  assert.equal(snapshot.workChainLength, 5);
});

test("every session moment is an evidence link and both chains verify", async () => {
  const session = new GovernedSession({
    id: "s2",
    task: "add tests",
    driver: new MockDriver(),
    now: fixedClock(),
  });
  await session.run();

  const v = session.verify();
  assert.equal(v.ok, true, `expected intact, got ${JSON.stringify(v)}`);
  assert.ok(session.log.length >= session.events.length - 0);
  // The log chain and the event stream are the same length (1 evidence per event).
  assert.equal(session.log.length, session.events.length);
});

test("the session emits a well-formed, ordered event stream", async () => {
  const events: ReefEvent[] = [];
  const session = new GovernedSession({
    id: "s3",
    task: "refactor",
    driver: new MockDriver(),
    now: fixedClock(),
    onEvent: (e) => events.push(e),
  });
  await session.run();

  assert.equal(events[0]?.kind, "session.created");
  assert.equal(events.at(-1)?.kind, "session.sealed");
  events.forEach((e, i) => assert.equal(e.seq, i, "seq must be contiguous"));
  assert.ok(events.some((e) => e.kind === "action.executed"));
});

test("the gate denies a dangerous action but the session still seals and verifies", async () => {
  const session = new GovernedSession({
    id: "s4",
    task: "clean up",
    driver: new UnsafeDemoDriver(),
    now: fixedClock(),
  });
  await session.run();

  const denied = session.events.filter((e) => e.kind === "action.denied");
  assert.equal(denied.length, 1, "the rm -rf / must be denied");
  assert.equal(session.workState, "done");
  assert.equal(session.verify().ok, true);
});

test("keyed mode produces a session that still verifies with the key", async () => {
  const session = new GovernedSession({
    id: "s5",
    task: "keyed run",
    driver: new MockDriver(),
    now: fixedClock(),
    integritySecret: "seed-user-secret",
  });
  await session.run();
  assert.equal(session.verify().ok, true);
});

test("a session round-trips through disk and re-verifies store-untrusting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-"));
  const session = new GovernedSession({
    id: "s6",
    task: "persist me",
    driver: new MockDriver(),
    now: fixedClock(),
  });
  await session.run();
  persistSession(session, dir);

  const loaded = loadSession(dir);
  assert.equal(loaded.workState, "done");
  assert.equal(loaded.logChainLength, session.log.length);
  assert.equal(loaded.workChainLength, session.graph.auditChain().length);
});

test("a tampered evidence log fails to load — the store is not trusted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-"));
  const session = new GovernedSession({
    id: "s7",
    task: "tamper me",
    driver: new MockDriver(),
    now: fixedClock(),
  });
  await session.run();
  persistSession(session, dir);

  const logPath = join(dir, "session.log.jsonl");
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  // Forge the content of the 5th record without re-deriving its hashes.
  const forged = JSON.parse(lines[4]!) as {
    evidence: { content: { summary: string } };
  };
  forged.evidence.content.summary = "a lie the store tells";
  lines[4] = JSON.stringify(forged);
  writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");

  assert.throws(() => loadSession(dir), /cannot restore EvidenceLog/);
});

test("a session runs exactly once", async () => {
  const session = new GovernedSession({
    id: "s8",
    task: "once",
    driver: new MockDriver(),
    now: fixedClock(),
  });
  await session.run();
  await assert.rejects(() => session.run(), /already ran/);
});
