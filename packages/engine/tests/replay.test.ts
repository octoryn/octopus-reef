/**
 * M6 — Replay. A persisted session reconstructs byte-for-byte from its verified
 * evidence log: the replayed timeline equals what the session emitted live, and
 * replay can only succeed on a log that verifies.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernedSession,
  MockDriver,
  persistSession,
  replaySession,
  type ReefEvent,
} from "../src/index.js";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 7, 0, 0, n++)).toISOString();
}

async function runAndPersist(
  dir: string,
  secret?: string,
): Promise<ReefEvent[]> {
  const live: ReefEvent[] = [];
  const session = new GovernedSession({
    id: "replay-me",
    task: "add rate limiting",
    driver: new MockDriver(),
    now: clock(),
    onEvent: (e) => live.push(e),
    ...(secret !== undefined ? { integritySecret: secret } : {}),
  });
  await session.run();
  persistSession(session, dir);
  return live;
}

test("M6 replay: reconstructs the session timeline byte-for-byte", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-replay-"));
  const live = await runAndPersist(dir);

  const replayed = replaySession(dir);
  // The replayed events equal EXACTLY what the session emitted live.
  assert.deepEqual(replayed.events, live);
  assert.ok(replayed.events.length > 0);
  assert.equal(replayed.events[0]?.kind, "session.created");
  assert.equal(replayed.events.at(-1)?.kind, "session.sealed");
  // seq is dense and ordered
  replayed.events.forEach((e, i) => assert.equal(e.seq, i));
  assert.equal(replayed.workState, "done");
});

test("M6 replay: a keyed session replays byte-for-byte under its secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-replay-k-"));
  const live = await runAndPersist(dir, "s3cr3t");

  const replayed = replaySession(dir, { integritySecret: "s3cr3t" });
  assert.deepEqual(replayed.events, live);
  assert.equal(replayed.authenticated, true);
});

test("M6 replay: a tampered log cannot be replayed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-replay-t-"));
  await runAndPersist(dir);

  // Flip a byte in a middle evidence record's summary.
  const logPath = join(dir, "session.log.jsonl");
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  lines[3] = lines[3]!.replace(/"summary":"[^"]*"/, '"summary":"TAMPERED"');
  writeFileSync(logPath, lines.join("\n") + "\n");

  assert.throws(() => replaySession(dir), /verif|integrity|binding|chain|log/i);
});
