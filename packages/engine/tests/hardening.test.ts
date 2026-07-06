/**
 * Regression tests for the M0 adversarial review (run wf_de0f8e91-11c).
 * Each test pins a confirmed finding so it cannot silently return.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernedSession,
  MockDriver,
  loadSession,
  persistSession,
  type Driver,
  type DriverContext,
  type DriverStep,
} from "../src/index.js";

function clock(base = 0): () => string {
  let n = base;
  return () => new Date(Date.UTC(2026, 6, 6, 0, 0, n++)).toISOString();
}

async function persisted(
  id: string,
  task: string,
  secret: string,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `reef-${id}-`));
  const s = new GovernedSession({
    id,
    task,
    driver: new MockDriver(),
    now: clock(),
    integritySecret: secret,
  });
  await s.run();
  persistSession(s, dir);
  return dir;
}

// ---- crypto-verify H1: cross-binding ----
test("H1: one session's log cannot be swapped under another's work spine", async () => {
  const secret = "shared";
  const a = await persisted("A", "deploy to prod", secret);
  const b = await persisted("B", "fix a typo", secret);

  // Swap B's evidence log under A's work spine.
  writeFileSync(
    join(a, "session.log.jsonl"),
    readFileSync(join(b, "session.log.jsonl")),
  );

  assert.throws(
    () => loadSession(a, { integritySecret: secret }),
    /cross-binding failed/,
    "a foreign log under A's spine must be rejected",
  );
});

// ---- crypto-verify H2: truncation / rollback ----
test("H2: truncating the evidence log tail (removing the seal) is caught", async () => {
  const dir = await persisted("T", "important work", "k");
  const logPath = join(dir, "session.log.jsonl");
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  writeFileSync(logPath, `${lines.slice(0, -1).join("\n")}\n`); // drop the seal

  assert.throws(
    () => loadSession(dir, { integritySecret: "k" }),
    /cross-binding failed|sealed/,
  );
});

test("H2: rolling back the work spine is caught by the seal anchor", async () => {
  const dir = await persisted("R", "reach done", "k");
  const workPath = join(dir, "workstate.jsonl");
  const lines = readFileSync(workPath, "utf8").trim().split("\n");
  // Drop the final transition pair to roll the spine backward.
  writeFileSync(workPath, `${lines.slice(0, -1).join("\n")}\n`);

  assert.throws(() => loadSession(dir, { integritySecret: "k" }));
});

// ---- state-machine H3: driver throws mid-stream ----
test("H3: a driver that throws mid-stream fails cleanly and still verifies", async () => {
  const thrower: Driver = {
    name: "thrower",
    async *run(_ctx: DriverContext): AsyncIterable<DriverStep> {
      yield { type: "observe", summary: "looking" };
      throw new Error("boom");
    },
  };
  const s = new GovernedSession({
    id: "throw",
    task: "explode",
    driver: thrower,
    now: clock(),
  });
  const { outcome } = await s.run();

  assert.equal(outcome, "failed");
  assert.equal(s.workState, "failed");
  assert.equal(s.snapshot().sealed, true);
  assert.equal(s.verify().ok, true, "a failed session is still provable");
});

// ---- state-machine H4: no silent success ----
test("H4: a driver that yields nothing fails rather than sealing a silent done", async () => {
  const empty: Driver = {
    name: "empty",
    // eslint-disable-next-line require-yield
    async *run(_ctx: DriverContext): AsyncIterable<DriverStep> {
      return;
    },
  };
  const s = new GovernedSession({
    id: "empty",
    task: "do nothing",
    driver: empty,
    now: clock(),
  });
  const { outcome } = await s.run();
  assert.equal(outcome, "failed", "an empty run is not a success");
  assert.equal(s.workState, "failed");
});

test("a no-op done-first session is completed but transparently records zero actions", async () => {
  const noop: Driver = {
    name: "noop",
    async *run(_ctx: DriverContext): AsyncIterable<DriverStep> {
      yield { type: "done", summary: "did nothing but claim done" };
    },
  };
  const s = new GovernedSession({
    id: "noop",
    task: "no-op",
    driver: noop,
    now: clock(),
  });
  const { snapshot } = await s.run();
  assert.equal(snapshot.outcome, "completed");
  assert.equal(
    snapshot.actionsExecuted,
    0,
    "the proof faithfully shows no work was done",
  );
});

// ---- type-honesty: non-JSON driver data ----
test("a driver injecting a non-JSON value fails the session, not the process", async () => {
  const badData: Driver = {
    name: "bad-data",
    async *run(_ctx: DriverContext): AsyncIterable<DriverStep> {
      yield {
        type: "observe",
        summary: "poison",
        data: { when: new Date() as unknown as string },
      };
      yield { type: "done", summary: "unreachable" };
    },
  };
  const s = new GovernedSession({
    id: "bad",
    task: "inject",
    driver: badData,
    now: clock(),
  });
  const { outcome } = await s.run();
  assert.equal(
    outcome,
    "failed",
    "non-JSON data is rejected at the boundary, failing the session cleanly",
  );
});

// ---- persistence: malformed log line ----
test("a malformed session log line throws a located error", async () => {
  const dir = await persisted("M", "parse me", "k");
  const logPath = join(dir, "session.log.jsonl");
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  lines.splice(2, 0, "{ not valid json");
  writeFileSync(logPath, `${lines.join("\n")}\n`);

  assert.throws(
    () => loadSession(dir, { integritySecret: "k" }),
    /malformed session log .* line 3/,
  );
});
