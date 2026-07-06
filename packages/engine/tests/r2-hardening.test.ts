/**
 * Regression tests for the confirming review (R2, run wf_834a64f6-d91).
 * These pin the fixes for findings introduced or missed by the R1 hardening.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernedSession,
  loadSession,
  persistSession,
  type Actor,
  type Driver,
  type DriverContext,
  type DriverStep,
} from "../src/index.js";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 6, 0, 0, n++)).toISOString();
}

/** A driver whose one action carries `label`, so two sessions differ only in content. */
function scriptedDriver(label: string): Driver {
  return {
    name: "scripted",
    async *run(_ctx: DriverContext): AsyncIterable<DriverStep> {
      yield { type: "observe", summary: `observing ${label}` };
      yield {
        type: "action",
        action: { type: "edit", summary: label, target: "config.yaml" },
      };
      yield { type: "done", summary: "done" };
    },
  };
}

// ---- R2 H1: identical (id, task, actor, clock) sessions must NOT collide ----
test("R2 H1: a foreign log cannot be swapped in even when spines would otherwise match", async () => {
  const secret = "shared-key";
  const id = "session-001";
  const task = "rotate the signing key";
  const actor: Actor = { id: "claude-agent", kind: "agent", source: "reef" };

  const mk = async (label: string): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "reef-r2-"));
    const s = new GovernedSession({
      id,
      task,
      actor,
      driver: scriptedDriver(label),
      now: clock(),
      integritySecret: secret,
    });
    await s.run();
    persistSession(s, dir);
    return dir;
  };

  const honest = await mk("edit staging.yaml");
  const malicious = await mk("steal prod secrets");

  // Swap the malicious log under the honest session's work spine.
  writeFileSync(
    join(honest, "session.log.jsonl"),
    readFileSync(join(malicious, "session.log.jsonl")),
  );

  assert.throws(
    () => loadSession(honest, { integritySecret: secret }),
    /cross-binding failed/,
    "the spine now commits the log head, so differing actions produce differing spines",
  );
});

// ---- R2 regression: AbortSignal observed even with zero / final-step aborts ----
test("R2: a session aborted before it starts finalises as cancelled", async () => {
  const ac = new AbortController();
  ac.abort();
  const s = new GovernedSession({
    id: "c1",
    task: "cancel me",
    driver: scriptedDriver("x"),
    now: clock(),
    signal: ac.signal,
  });
  const { outcome } = await s.run();
  assert.equal(outcome, "cancelled");
  assert.equal(s.workState, "cancelled");
  assert.equal(s.verify().ok, true);
});

test("R2: a session whose driver yields zero steps under an aborted signal is cancelled, not failed", async () => {
  const ac = new AbortController();
  const empty: Driver = {
    name: "empty",
    // eslint-disable-next-line require-yield
    async *run(_ctx: DriverContext): AsyncIterable<DriverStep> {
      ac.abort(); // abort arrives, but there is no next loop iteration to see it
      return;
    },
  };
  const s = new GovernedSession({
    id: "c2",
    task: "empty cancel",
    driver: empty,
    now: clock(),
    signal: ac.signal,
  });
  const { outcome } = await s.run();
  assert.equal(
    outcome,
    "cancelled",
    "the after-loop check must catch a zero-step abort",
  );
});
