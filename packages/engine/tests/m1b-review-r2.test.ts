/**
 * Regression tests for the M1b confirming review (run wdyrlwxu5).
 * HIGH: a DANGLING final-component symlink escaped the realpath ancestor check
 * (existsSync follows links, so a dangling one looked missing and the walk
 * climbed past it). MED: realpathSync(root) threw when the root didn't exist
 * yet, breaking first-write bootstrap. MED: git global options before the
 * subcommand (`--no-pager`, `-C`) were wrongly denied.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceExecutor, reefAllowlist } from "../src/index.js";

// ---- HIGH: a dangling symlink cannot be written THROUGH to escape the root ----
test("M1b R2 HIGH: a dangling final-component symlink cannot write outside the workspace", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "reef-out-"));
  const ghost = join(outside, "ghost.txt"); // target does NOT exist (dangling)
  symlinkSync(ghost, join(ws, "z"));

  const ex = new WorkspaceExecutor(ws);
  const write = await ex.execute({
    type: "edit",
    summary: "",
    target: "z",
    payload: { content: "ESCAPE" },
  });

  assert.equal(write.ok, false);
  assert.match(write.error ?? "", /symlink/);
  assert.equal(
    existsSync(ghost),
    false,
    "the write must not have followed the dangling link out of the workspace",
  );
});

// ---- MED: a not-yet-existing workspace root bootstraps on first write ----
test("M1b R2 MED: a missing workspace root is created on first edit, not thrown", async () => {
  const parent = mkdtempSync(join(tmpdir(), "reef-parent-"));
  const root = join(parent, "does-not-exist-yet", "nested");

  const ex = new WorkspaceExecutor(root);
  const write = await ex.execute({
    type: "edit",
    summary: "",
    target: "x.txt",
    payload: { content: "ok" },
  });

  assert.equal(write.ok, true, write.error ?? "");
  assert.equal(readFileSync(join(root, "x.txt"), "utf8"), "ok");
  rmSync(parent, { recursive: true, force: true });
});

// ---- MED: git global options before the subcommand still parse ----
test("M1b R2 MED: benign git global options are allowed; injection vectors are denied", () => {
  const a = reefAllowlist();
  const P = { id: "x", roles: [] as readonly string[], source: "t" };
  const cmd = (id: string): boolean =>
    a.can(P, "reef.action.command", { type: "command", id }) as boolean;

  // benign global options before a read-only subcommand → allowed
  assert.equal(cmd("git --no-pager log"), true);
  assert.equal(cmd("git -C /some/repo status"), true);
  assert.equal(cmd("git --git-dir=/r/.git diff"), true);

  // config / exec-path injection → hard-denied even before a read-only subcommand
  assert.equal(cmd("git -c core.pager=evil status"), false);
  assert.equal(cmd("git --exec-path=/tmp/evil status"), false);
  assert.equal(cmd("git --config-env=core.pager=EV status"), false);

  // still-denied write/destructive subcommands (regression guard)
  assert.equal(cmd("git remote add exfil https://attacker.example/r"), false);
  assert.equal(cmd("git branch -D main"), false);
  // a global option in front of a denied subcommand stays denied
  assert.equal(cmd("git -C /repo remote add x https://a.example/r"), false);
});
