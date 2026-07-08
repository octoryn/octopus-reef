/**
 * Tests for the external-CLI worker. A stub CLI (a `node -e` one-liner that edits
 * a file) stands in for Claude Code / Codex: the worker runs it confined to a
 * workspace, captures its file EFFECTS as evidence, and the governed sub-session
 * verifies — proving what an agent we didn't write actually changed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliWorker, runCliWithDiff } from "../src/index.js";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 8, 0, 0, n++)).toISOString();
}

/** A stub "agent CLI": a node one-liner that writes a file into the workspace. */
const writeFileArgv = (content: string): readonly string[] => [
  process.execPath,
  "-e",
  `require('fs').writeFileSync('result.txt', ${JSON.stringify(content)})`,
];

test("runCliWithDiff captures the exact files an external process changed", () => {
  const ws = mkdtempSync(join(tmpdir(), "cli-"));
  try {
    writeFileSync(join(ws, "existing.txt"), "before");
    const res = runCliWithDiff(
      [
        process.execPath,
        "-e",
        "const fs=require('fs');fs.writeFileSync('new.txt','x');fs.writeFileSync('existing.txt','after');",
      ],
      ws,
    );
    assert.equal(res.exitCode, 0);
    const byPath = Object.fromEntries(
      res.changed.map((c) => [c.path, c.status]),
    );
    assert.equal(byPath["new.txt"], "added");
    assert.equal(byPath["existing.txt"], "modified");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cliWorker runs an external CLI, governs it, and its sub-session verifies", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cli-"));
  try {
    const worker = cliWorker({
      name: "stub-agent",
      description: "a stub external coding agent",
      workspace: ws,
      buildArgv: (subtask) => writeFileArgv(`fixed: ${subtask}`),
      now: clock(),
    });
    const result = await worker.run("make the change");
    assert.equal(result.outcome, "completed");
    assert.equal(result.verified, true, "the governed sub-session verifies");
    assert.match(result.workHead, /^[0-9a-f]{64}$/);
    // the external agent really wrote the file (its effect)
    assert.equal(
      readFileSync(join(ws, "result.txt"), "utf8"),
      "fixed: make the change",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cliWorker reports failure when the external CLI exits non-zero", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cli-"));
  try {
    const worker = cliWorker({
      name: "failing-agent",
      description: "a stub that fails",
      workspace: ws,
      buildArgv: () => [process.execPath, "-e", "process.exit(3)"],
      now: clock(),
    });
    const result = await worker.run("do the impossible");
    assert.equal(result.outcome, "failed");
    assert.equal(result.verified, true, "even a failed run is provable");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
