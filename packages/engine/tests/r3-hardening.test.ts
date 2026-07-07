/**
 * Regression tests for the convergence review (R3, run whf1mjhp0).
 * The gate multi-line bypass (HIGH) is covered in gate.test.ts; here we prove the
 * two verify.ts hardenings reject a forged UNKEYED log (the documented unkeyed
 * threat model is otherwise re-mintable, so these are the extra invariants).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidence, nextLink } from "octopus-evidence";
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

function scriptedDriver(label: string, done = true): Driver {
  return {
    name: "scripted",
    async *run(_ctx: DriverContext): AsyncIterable<DriverStep> {
      yield { type: "observe", summary: `observing ${label}` };
      yield {
        type: "action",
        action: { type: "edit", summary: label, target: "config.yaml" },
      };
      if (done) yield { type: "done", summary: "done" };
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function readRecords(dir: string): any[] {
  return readFileSync(join(dir, "session.log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}
function writeRecords(dir: string, recs: any[]): void {
  writeFileSync(
    join(dir, "session.log.jsonl"),
    recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

/** Re-mint an unkeyed log after mutating the last (seal) evidence's content. */
function remintWithMutatedSeal(
  recs: any[],
  mutate: (content: any) => void,
): any[] {
  const evs = recs.map((r) => r.evidence);
  mutate(evs[evs.length - 1].content);
  const last = evs[evs.length - 1];
  evs[evs.length - 1] = createEvidence({
    kind: last.kind,
    subject: last.subject,
    ...(last.actor !== undefined ? { actor: last.actor } : {}),
    content: last.content,
    provenance: last.provenance,
  });
  const chain: any[] = [];
  return evs.map((ev: any) => {
    const link = nextLink(chain, ev.id);
    chain.push(link);
    return { evidence: ev, link };
  });
}

// ---- R3 LOW: seal outcome must agree with the spine terminal state ----
test("R3: a forged seal outcome (completed over a failed spine) is rejected — unkeyed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-r3o-"));
  const failing: Driver = {
    name: "fail",
    async *run(_ctx: DriverContext): AsyncIterable<DriverStep> {
      yield { type: "fail", summary: "gave up" };
    },
  };
  const s = new GovernedSession({
    id: "o1",
    task: "must fail",
    driver: failing,
    now: clock(),
  });
  await s.run();
  assert.equal(s.outcome, "failed");
  persistSession(s, dir);

  const forged = remintWithMutatedSeal(readRecords(dir), (c) => {
    c.outcome = "completed";
  });
  writeRecords(dir, forged);

  assert.throws(
    () => loadSession(dir),
    /does not match the spine terminal state/,
  );
});

// ---- R3 LOW: bidirectional bind — a foreign log with a re-minted workAnchor is caught ----
test("R3: a foreign log attached via re-minted workAnchor is caught by the spine→log bind — unkeyed", async () => {
  const id = "session-001";
  const task = "rotate the signing key";
  const actor: Actor = { id: "claude-agent", kind: "agent", source: "reef" };

  const build = async (label: string) => {
    const dir = mkdtempSync(join(tmpdir(), "reef-r3b-"));
    const s = new GovernedSession({
      id,
      task,
      actor,
      driver: scriptedDriver(label),
      now: clock(),
    });
    await s.run();
    persistSession(s, dir);
    return { dir, s };
  };

  const honest = await build("edit staging.yaml");
  const foreign = await build("steal prod secrets");

  // Re-mint the foreign log's seal so its workAnchor matches the HONEST spine —
  // defeating the workAnchor check. The spine→log committed-head bind must still catch it.
  const anchor = honest.s.graph.anchor();
  const forgedLog = remintWithMutatedSeal(readRecords(foreign.dir), (c) => {
    c.workAnchor = { length: anchor.length, head: anchor.head };
  });
  writeRecords(honest.dir, forgedLog); // honest spine + forged foreign log

  assert.throws(
    () => loadSession(honest.dir),
    /committed log-head does not match|does not match the spine/,
  );
});
