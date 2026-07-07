/**
 * M6 (Blackboard) — shared cognition for parallel agents on one session. Two
 * agents share a board; one claims a task, the other's claim conflicts (no
 * double work); notes land on the shared timeline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionBoard, claimedCleanly } from "../src/index.js";

test("blackboard: parallel agents coordinate — a claim conflict prevents double work", () => {
  const boardDir = mkdtempSync(join(tmpdir(), "reef-board-"));
  const claude = openSessionBoard(boardDir, "claude");

  // claude claims a task cleanly
  assert.equal(claimedCleanly(claude, "claude", "impl-rate-limit"), true);

  // a second agent on the SAME board sees the conflict
  const gemini = openSessionBoard(boardDir, "gemini");
  const conflict = gemini.claim("gemini", "impl-rate-limit");
  assert.equal(conflict.conflict, "claude");

  // notes land on the shared timeline; the task is visible to both
  claude.note("claude", "started impl-rate-limit");
  assert.ok(claude.getTask("impl-rate-limit"));
  assert.ok(gemini.getTask("impl-rate-limit"));

  claude.close();
  gemini.close();
});

test("blackboard: releasing a task lets another agent claim it", () => {
  const boardDir = mkdtempSync(join(tmpdir(), "reef-board-"));
  const a = openSessionBoard(boardDir, "a");
  assert.equal(claimedCleanly(a, "a", "task-x"), true);
  a.release("a", "task-x");

  const b = openSessionBoard(boardDir, "b");
  assert.equal(b.claim("b", "task-x").conflict, null);
  a.close();
  b.close();
});
