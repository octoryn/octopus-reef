/**
 * Regression tests for the M1b R3 confirming review (run wtt7tomly).
 * MED: the R2 "reject ANY symlink component" rewrite over-corrected and blocked
 * legitimate IN-ROOT symlinks (e.g. `latest -> v1`). LOW: gitSubcommand's `-c`
 * hard-deny matched only the space form, so an attached `-ccore.pager=…` slipped
 * through (inert — real git rejects attached -c — but tightened anyway).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceExecutor, reefAllowlist } from "../src/index.js";

// ---- MED: symlinks that stay INSIDE the root are allowed (read + write) ----
test("M1b R3 MED: an in-root symlink is not rejected as an escape", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  mkdirSync(join(ws, "v1"));
  writeFileSync(join(ws, "v1", "index.js"), "V1");
  writeFileSync(join(ws, "data.json"), "{}");
  symlinkSync("v1", join(ws, "latest")); // dir alias, in-root
  symlinkSync("data.json", join(ws, "current.json")); // file alias, in-root

  const ex = new WorkspaceExecutor(ws);

  const readViaDirLink = await ex.execute({
    type: "read",
    summary: "",
    target: "latest/index.js",
  });
  assert.equal(readViaDirLink.ok, true, readViaDirLink.error ?? "");
  assert.equal(readViaDirLink.output, "V1");

  const readViaFileLink = await ex.execute({
    type: "read",
    summary: "",
    target: "current.json",
  });
  assert.equal(readViaFileLink.ok, true, readViaFileLink.error ?? "");
  assert.equal(readViaFileLink.output, "{}");

  const writeViaDirLink = await ex.execute({
    type: "edit",
    summary: "",
    target: "latest/new.txt",
    payload: { content: "ok" },
  });
  assert.equal(writeViaDirLink.ok, true, writeViaDirLink.error ?? "");

  // the write landed on the real in-root target
  const readBack = await ex.execute({
    type: "read",
    summary: "",
    target: "v1/new.txt",
  });
  assert.equal(readBack.output, "ok");
});

// ---- LOW: the attached `-c<cfg>` form is also hard-denied ----
test("M1b R3 LOW: git -c config injection is denied in the attached form too", () => {
  const a = reefAllowlist();
  const P = { id: "x", roles: [] as readonly string[], source: "t" };
  const cmd = (id: string): boolean =>
    a.can(P, "reef.action.command", { type: "command", id }) as boolean;

  assert.equal(cmd("git -ccore.pager=evil log"), false);
  assert.equal(cmd("git -cprotocol.ext.allow=always log"), false);
  // -C (uppercase, an in-repo path) is a benign global flag and still parses
  assert.equal(cmd("git -C /some/repo status"), true);
});
