/**
 * M1b-3: sandboxed command execution.
 *
 * Deterministic tests inject a fake CommandRunner (no real process). A
 * darwin-only test exercises the real `sandbox-exec` runner to prove the OS
 * actually blocks an out-of-root write and denies the network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernedSession,
  SandboxExecutor,
  canonicalRoot,
  reefAllowlist,
  type ActionRequest,
  type CommandResult,
  type CommandRunner,
  type Driver,
  type DriverStep,
} from "../src/index.js";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 7, 0, 0, n++)).toISOString();
}

function capturingRunner(result: CommandResult): {
  runner: CommandRunner;
  calls: {
    argv: readonly string[];
    cwd: string;
    env: Record<string, string>;
  }[];
} {
  const calls: {
    argv: readonly string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  const runner: CommandRunner = {
    name: "fake",
    run(argv, opts) {
      calls.push({ argv, cwd: opts.cwd, env: { ...opts.env } });
      return Promise.resolve(result);
    },
  };
  return { runner, calls };
}

const cmd = (command: string): ActionRequest => ({
  type: "command",
  summary: "",
  payload: { command },
});

// ---- argv is spawned literally, in the canonical workspace, with scrubbed env ----
test("M1b-3: a command runs shell-free in the canonical root with a scrubbed env", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const { runner, calls } = capturingRunner({
    code: 0,
    stdout: "hello\n",
    stderr: "",
    timedOut: false,
  });
  const ex = new SandboxExecutor(ws, { runner, timeoutMs: 1234 });

  const r = await ex.execute(cmd("echo hello"));
  assert.equal(r.ok, true);
  assert.equal(r.output, "hello");
  assert.equal(r.exitCode, 0);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.argv, ["echo", "hello"]); // split, no shell
  assert.equal(calls[0]!.cwd, canonicalRoot(ws));
  // scrubbed: only PATH/HOME/locale-ish keys, never arbitrary inherited secrets
  const allowed = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]);
  for (const k of Object.keys(calls[0]!.env)) {
    assert.ok(allowed.has(k), `unexpected env key leaked: ${k}`);
  }
});

// ---- a non-zero exit is a failure, surfacing stderr ----
test("M1b-3: a non-zero exit fails with stderr as the error", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const { runner } = capturingRunner({
    code: 2,
    stdout: "",
    stderr: "boom\n",
    timedOut: false,
  });
  const ex = new SandboxExecutor(ws, { runner });

  const r = await ex.execute(cmd("git status"));
  assert.equal(r.ok, false);
  assert.equal(r.error, "boom");
  assert.equal(r.exitCode, 2);
});

// ---- a timeout is a failure ----
test("M1b-3: a timed-out command fails clearly", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const { runner } = capturingRunner({
    code: null,
    stdout: "",
    stderr: "",
    timedOut: true,
  });
  const ex = new SandboxExecutor(ws, { runner, timeoutMs: 500 });

  const r = await ex.execute(cmd("node forever.js"));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /timed out after 500ms/);
});

// ---- an empty command is rejected before any runner call ----
test("M1b-3: an empty command is rejected", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const { runner, calls } = capturingRunner({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  const ex = new SandboxExecutor(ws, { runner });

  const r = await ex.execute(cmd("   "));
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

// ---- read/edit are delegated to the confined WorkspaceExecutor ----
test("M1b-3: file ops stay confined (symlink escape still blocked)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "reef-out-"));
  symlinkSync(outside, join(ws, "dir")); // dir symlink → outside
  const { runner } = capturingRunner({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  const ex = new SandboxExecutor(ws, { runner });

  const escape = await ex.execute({
    type: "edit",
    summary: "",
    target: "dir/planted.txt",
    payload: { content: "PWNED" },
  });
  assert.equal(escape.ok, false);
  assert.equal(existsSync(join(outside, "planted.txt")), false);

  const ok = await ex.execute({
    type: "edit",
    summary: "",
    target: "note.txt",
    payload: { content: "ok" },
  });
  assert.equal(ok.ok, true);
});

// ---- pr is not locally executable ----
test("M1b-3: pr actions are not executed by the sandbox", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const { runner } = capturingRunner({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  const ex = new SandboxExecutor(ws, { runner });
  const r = await ex.execute({ type: "pr", summary: "open a PR" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /outward-facing/);
});

// ---- end-to-end: a governed session runs an allowlisted command, denies the rest ----
test("M1b-3: a governed session executes an allowlisted command through the sandbox", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const { runner, calls } = capturingRunner({
    code: 0,
    stdout: "nothing to commit\n",
    stderr: "",
    timedOut: false,
  });
  const driver: Driver = {
    name: "cmd",
    async *run(): AsyncIterable<DriverStep> {
      yield { type: "action", action: cmd("git status") }; // allowlisted → runs
      yield { type: "action", action: cmd("rm -rf /") }; // denied → never runs
      yield { type: "done", summary: "checked" };
    },
  };
  const session = new GovernedSession({
    id: "s",
    task: "check status",
    driver,
    authorizer: reefAllowlist(),
    executor: new SandboxExecutor(ws, { runner }),
    now: clock(),
  });

  const { snapshot } = await session.run();
  assert.equal(snapshot.outcome, "completed");
  assert.equal(snapshot.actionsExecuted, 1);
  assert.equal(snapshot.actionsDenied, 1);
  // only the allowlisted command reached the runner
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.argv, ["git", "status"]);
  assert.equal(session.verify().ok, true);
});

// ---- REAL macOS sandbox: the OS blocks an out-of-root write and network ----
if (process.platform === "darwin") {
  test("M1b-3 [darwin]: sandbox-exec blocks out-of-root writes; benign commands run", async () => {
    const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
    writeFileSync(join(ws, "seed.txt"), "seed"); // a real in-root file
    const ex = new SandboxExecutor(ws); // real darwin-sandbox-exec runner
    assert.equal(ex.runnerName, "darwin-sandbox-exec");

    // a write OUTSIDE the workspace is denied by the OS
    const escapePath = join(outsideDir(), "reef-escape.txt");
    const escape = await ex.execute(cmd(`touch ${escapePath}`));
    assert.equal(escape.ok, false, "out-of-root touch must be denied");
    assert.equal(existsSync(escapePath), false, "no file was created outside");

    // a benign command still runs and returns output
    const version = await ex.execute(cmd("node --version"));
    assert.equal(version.ok, true, version.error ?? "");
    assert.match(version.output ?? "", /^v\d+\./);
  });
}

/** A sibling temp dir guaranteed OUTSIDE any created workspace. */
function outsideDir(): string {
  return mkdtempSync(join(tmpdir(), "reef-escape-"));
}
