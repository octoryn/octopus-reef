/**
 * M1b-3: sandboxed command execution.
 *
 * Deterministic tests inject a fake CommandRunner (no real process). A
 * darwin-only test exercises the real `sandbox-exec` runner to prove the OS
 * actually blocks an out-of-root write and denies the network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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

interface Call {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  writableRoots: readonly string[];
}

function capturingRunner(result: CommandResult): {
  runner: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: CommandRunner = {
    name: "fake",
    run(argv, opts) {
      calls.push({
        argv,
        cwd: opts.cwd,
        env: { ...opts.env },
        writableRoots: opts.writableRoots,
      });
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
  assert.deepEqual(calls[0]!.argv, ["echo", "hello"]); // split, no shell (non-git: unhardened)
  assert.equal(calls[0]!.cwd, canonicalRoot(ws));
  // neutralised env: only the known-safe/neutralising keys, no inherited secrets
  const env = calls[0]!.env;
  const allowed = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_TERMINAL_PROMPT",
  ]);
  for (const k of Object.keys(env)) {
    assert.ok(allowed.has(k), `unexpected env key leaked: ${k}`);
  }
  // HOME is a throwaway, NOT the real home (no ~/.ssh, ~/.gitconfig in reach)
  assert.notEqual(env.HOME, process.env.HOME);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  // the workspace is a writable root for the sandbox
  assert.ok(calls[0]!.writableRoots.includes(canonicalRoot(ws)));
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
  // only the allowlisted command reached the runner, and git was hardened
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.argv[0], "git");
  assert.ok(calls[0]!.argv.includes("status"));
  assert.ok(calls[0]!.argv.includes("core.fsmonitor=")); // config code-exec neutralised
  assert.ok(calls[0]!.argv.includes("--no-pager"));
  assert.equal(session.verify().ok, true);
});

// ---- review HIGH: general file-read tools are no longer authorized ----
test("M1b-3 review: cat/ls/grep are not on the command allowlist (exfil channel closed)", () => {
  const a = reefAllowlist();
  const P = { id: "x", roles: [] as readonly string[], source: "t" };
  const can = (id: string): boolean =>
    a.can(P, "reef.action.command", { type: "command", id }) as boolean;
  assert.equal(can("cat /etc/passwd"), false);
  assert.equal(can("cat /Users/anyone/.ssh/id_rsa"), false);
  assert.equal(can("ls /etc"), false);
  assert.equal(can("grep -r secret /"), false);
  assert.equal(can("head /etc/hosts"), false);
  // the build/VCS toolchain is still allowed
  assert.equal(can("git status"), true);
  assert.equal(can("node --version"), true);
});

// ---- review HIGH: git config code-exec knobs are neutralised on the argv ----
test("M1b-3 review: git argv is hardened against repo/global config code execution", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const { runner, calls } = capturingRunner({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  const ex = new SandboxExecutor(ws, { runner });

  await ex.execute(cmd("git status"));
  const status = calls[0]!.argv;
  assert.ok(status.includes("core.fsmonitor="), "fsmonitor disabled");
  assert.ok(status.includes("core.hooksPath=/dev/null"), "hooks disabled");
  assert.ok(status.includes("core.pager=cat"), "pager neutralised");
  assert.ok(status.includes("diff.external="), "external diff disabled");

  // diff-family also disables textconv / external diff at the subcommand level
  await ex.execute(cmd("git diff HEAD"));
  const diff = calls[1]!.argv;
  assert.ok(diff.includes("--no-textconv"));
  assert.ok(diff.includes("--no-ext-diff"));
  // the original subcommand + args are preserved, in order after the subcommand
  const di = diff.indexOf("diff");
  assert.ok(di >= 0 && diff.indexOf("HEAD") > di);
});

// ---- MED: a timed-out command with a real runner resolves (never hangs) ----
test("M1b-3 review: a real long-running command resolves on timeout", async () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const ex = new SandboxExecutor(ws, { timeoutMs: 700 }); // real platform runner
  const r = await ex.execute(cmd("node -e setTimeout(function(){},60000)"));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /timed out after 700ms/);
  ex.dispose();
});

// ---- MED: the throwaway HOME is cleaned up on dispose ----
test("M1b-3 review: dispose() removes the throwaway HOME (no temp-dir leak)", () => {
  const ws = mkdtempSync(join(tmpdir(), "reef-ws-"));
  const ex = new SandboxExecutor(ws);
  const home = ex.homeDir;
  assert.equal(existsSync(home), true);
  ex.dispose();
  assert.equal(existsSync(home), false, "throwaway HOME must be removed");
  ex.dispose(); // idempotent
});

// ---- REAL macOS sandbox: the OS blocks writes, network, AND real-HOME reads ----
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
    ex.dispose();
  });

  test("M1b-3 [darwin] review HIGH: git repo-config code-exec cannot exfiltrate a real-HOME secret", async () => {
    // Plant a fake secret in the REAL home. Even when an attacker-controlled repo
    // runs code via a git clean-filter during a sandboxed `git diff`, the OS must
    // deny reading it — the filter runs, but reaches no secret.
    const secretPath = join(homedir(), `.reef-fake-secret-${process.pid}`);
    writeFileSync(secretPath, "SECRET=sk-VICTIM-abc123");
    try {
      const ws = mkdtempSync(join(tmpdir(), "reef-attack-"));
      const git = (a: string): void => {
        execSync(`git ${a}`, { cwd: ws });
      };
      git("init -q");
      git("config user.email a@b.c");
      git("config user.name a");
      // Commit CLEAN content first (no filter configured yet — nothing baked in).
      writeFileSync(join(ws, "data.txt"), "v1\n");
      git("add data.txt");
      git("commit -q -m init");
      // Now configure the malicious clean filter and dirty the worktree, so the
      // SANDBOXED `git diff` is what triggers the filter.
      const evil = join(ws, "evil.sh");
      // `|| true` so the denied read doesn't fail the filter (git would then
      // discard its output); the marker proves the code ran under the sandbox.
      writeFileSync(
        evil,
        `#!/bin/sh\necho FILTER-RAN\ncat "${secretPath}" 2>/dev/null || true\nexit 0\n`,
      );
      chmodSync(evil, 0o755);
      writeFileSync(join(ws, ".gitattributes"), "data.txt filter=evil\n");
      git("config filter.evil.clean ./evil.sh");
      writeFileSync(join(ws, "data.txt"), "v2\n"); // dirty → diff re-cleans it

      const ex = new SandboxExecutor(ws);
      const r = await ex.execute(cmd("git diff"));
      const surfaced = `${r.output ?? ""}${r.error ?? ""}`;
      assert.ok(
        surfaced.includes("FILTER-RAN"),
        "the filter must actually run under the sandbox (else the test proves nothing)",
      );
      assert.equal(
        surfaced.includes("sk-VICTIM-abc123"),
        false,
        "the real-HOME secret must NOT be exfiltrated through git output",
      );
      ex.dispose();
    } finally {
      rmSync(secretPath, { force: true });
    }
  });
}

/** A sibling temp dir guaranteed OUTSIDE any created workspace. */
function outsideDir(): string {
  return mkdtempSync(join(tmpdir(), "reef-escape-"));
}
