/**
 * Sandboxed command execution (M1b-3) — the seam where an *authorized* command
 * actually runs, under OS confinement.
 *
 * After the 2026-07-06 incident, Reef never runs a real command on a denylist's
 * say-so. A command reaches {@link SandboxExecutor} only after it has (1) passed
 * the tripwire and (2) been authorized by the allowlist (`reefAllowlist` — a
 * SMALL set of build/VCS tools, no shell operators). The sandbox is the THIRD,
 * independent layer. Every command runs:
 *   - with NO shell (argv is spawned directly — operators can't be interpreted),
 *   - confined to the workspace (writes anywhere else are denied by the OS),
 *   - with the network denied,
 *   - under a hard timeout that kills the whole process group,
 *   - with a NEUTRALISED environment — a throwaway empty HOME and TMPDIR (so a
 *     tool can't read `~/.ssh`, `~/.aws`, or honour `~/.gitconfig`), no inherited
 *     secrets, and git's system/global config disabled, and
 *   - for `git`, with config-driven code-execution knobs neutralised on the
 *     command line (fsmonitor / pager / hooks / external-diff / textconv), since
 *     a repo's own `.git/config` is untrusted.
 *
 * Honest scope: on macOS `sandbox-exec` denies network + out-of-root writes, and
 * sensitive real-HOME paths are read-denied — but reads are otherwise
 * unrestricted (a fully read-confining profile is not portable across
 * toolchains). The allowlist therefore excludes general file-read tools
 * (cat/ls/grep) — reads go through Reef's confined `read`/`search` actions, not
 * the shell. STRONG isolation for a fully untrusted repo is the container's job
 * (Docker, M5); the local sandbox is defense-in-depth. On non-macOS the process
 * is still cwd-confined, time-bounded, shell-free, and env-neutralised, but
 * OS-level network/write isolation is best-effort — {@link SandboxExecutor}
 * reports which runner is active so a surface can warn.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionRequest } from "./types.js";
import {
  canonicalRoot,
  WorkspaceExecutor,
  type ActionExecutor,
  type ExecOutcome,
} from "./executor.js";

/** The raw result of running a command. */
export interface CommandResult {
  /** Process exit code, or null if it was killed / failed to spawn. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The command was killed because it exceeded the timeout. */
  readonly timedOut: boolean;
}

/** Options handed to a {@link CommandRunner}. */
export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  /** Directories the OS sandbox should permit writes to (workspace + home). */
  readonly writableRoots: readonly string[];
}

/** Runs a fully-formed argv. Injectable so tests never touch a real process. */
export interface CommandRunner {
  readonly name: string;
  run(argv: readonly string[], opts: RunOptions): Promise<CommandResult>;
}

const OUTPUT_CAP = 16_000;

/**
 * Spawn `cmd argv` with no shell, in its own process group, capturing bounded
 * output and enforcing a timeout that kills the WHOLE group (not just the direct
 * child — a grandchild would otherwise survive and could hold the pipe open).
 */
function spawnCollect(
  cmd: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: { ...opts.env },
      shell: false, // NEVER a shell — argv is literal, operators can't run
      detached: true, // own process group, so we can kill grandchildren too
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal); // group gone / never formed — fall back to the child
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
    }, opts.timeoutMs);
    const append = (buf: string, d: Buffer): string =>
      buf.length >= OUTPUT_CAP
        ? buf
        : buf + d.toString("utf8").slice(0, OUTPUT_CAP - buf.length);
    child.stdout?.on("data", (d: Buffer) => {
      stdout = append(stdout, d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = append(stderr, d);
    });
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", (err: Error) => {
      if (stderr.length < OUTPUT_CAP) stderr += err.message;
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

/** Escape a path for inclusion in an `sandbox-exec` SBPL string literal. */
function sbplEscape(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Real-HOME subpaths a sandboxed command must never read (credentials/keys). */
function sensitiveReadDenies(): string {
  const home = homedir();
  if (home === "" || home === "/") return "";
  const denied = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".docker",
    ".kube",
    ".config/gh",
    ".config/git",
    ".config/gcloud",
    "Library/Keychains",
  ].map((rel) => `(subpath "${sbplEscape(join(home, rel))}")`);
  return `(deny file-read* ${denied.join(" ")})`;
}

/**
 * An SBPL profile: allow by default, but DENY the network, DENY every filesystem
 * write except the workspace/home, and DENY reads of well-known secret paths.
 * "allow default" keeps ordinary toolchain binaries working (their libraries
 * live in unpredictable places); the explicit denies are the confinement.
 */
function darwinProfile(writableRoots: readonly string[]): string {
  const writes = writableRoots
    .map((r) => `(subpath "${sbplEscape(r)}")`)
    .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* ${writes})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero")' +
      ' (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")' +
      ' (literal "/dev/dtracehelper"))',
    sensitiveReadDenies(),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** macOS: wrap the command in `sandbox-exec` with the confinement profile. */
export const darwinSandboxRunner: CommandRunner = {
  name: "darwin-sandbox-exec",
  run(argv, opts) {
    const profile = darwinProfile(opts.writableRoots);
    return spawnCollect("sandbox-exec", ["-p", profile, ...argv], opts);
  },
};

/**
 * Non-macOS: cwd-confined, time-bounded, shell-free, env-neutralised — but
 * WITHOUT OS network/write isolation. Safe here only because the command already
 * passed the small build/VCS allowlist; surfaces should still warn.
 */
export const subprocessRunner: CommandRunner = {
  name: "subprocess",
  run(argv, opts) {
    const [cmd, ...args] = argv;
    return spawnCollect(cmd ?? "", args, opts);
  },
};

/** The runner for the current platform. */
export function defaultRunner(): CommandRunner {
  return process.platform === "darwin" ? darwinSandboxRunner : subprocessRunner;
}

/**
 * A neutralised environment: PATH/locale kept so binaries run, but HOME and
 * TMPDIR point at a private throwaway dir (no `~/.ssh`, `~/.gitconfig`), git's
 * system/global config is disabled, and NO other inherited variable (API keys,
 * tokens) is passed through.
 */
function sandboxEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of ["PATH", "LANG", "LC_ALL"]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

/** git global options that consume the following token as their value. */
const GIT_ARG_FLAGS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

/**
 * Neutralise git's config-driven code-execution vectors on the command line,
 * since a repo's own `.git/config`/`.gitattributes` is untrusted. Command-line
 * `-c` overrides repo-local config, so fsmonitor/pager/hooks/external-diff are
 * forced off; for diff-family subcommands, textconv/ext-diff are disabled too.
 */
function hardenGitArgv(argv: readonly string[]): string[] {
  const rest = argv.slice(1);
  const globals = [
    "-c",
    "core.fsmonitor=",
    "-c",
    "core.pager=cat",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "diff.external=",
    "--no-pager",
  ];
  // Locate the subcommand (first non-flag token, skipping arg-taking flags).
  let subIdx = -1;
  let sub = "";
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (GIT_ARG_FLAGS.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    subIdx = i;
    sub = t;
    break;
  }
  const out = ["git", ...globals, ...rest];
  if (subIdx >= 0 && (sub === "diff" || sub === "log" || sub === "show")) {
    out.splice(
      1 + globals.length + subIdx + 1,
      0,
      "--no-textconv",
      "--no-ext-diff",
    );
  }
  return out;
}

export interface SandboxOptions {
  /** Override the process runner (tests inject a fake). */
  readonly runner?: CommandRunner;
  /** Hard timeout per command. Default 10s. */
  readonly timeoutMs?: number;
}

/**
 * Executes `read`/`edit` (confined, via {@link WorkspaceExecutor}) AND real
 * `command`s (sandboxed). Pair it ONLY with `reefAllowlist` — the sandbox is a
 * second layer of defense, not a substitute for the allowlist. `pr` remains
 * unsupported (outward-facing actions are out of scope for local execution).
 */
export class SandboxExecutor implements ActionExecutor {
  readonly name = "sandbox";
  readonly #root: string;
  readonly #home: string;
  readonly #files: WorkspaceExecutor;
  readonly #runner: CommandRunner;
  readonly #timeoutMs: number;
  readonly #env: Readonly<Record<string, string>>;

  constructor(root: string, options: SandboxOptions = {}) {
    this.#root = canonicalRoot(root);
    this.#files = new WorkspaceExecutor(root);
    this.#runner = options.runner ?? defaultRunner();
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    // A private, empty HOME/TMPDIR for every command this executor runs.
    this.#home = mkdtempSync(join(tmpdir(), "reef-home-"));
    this.#env = sandboxEnv(this.#home);
  }

  /** Which runner is active — so a surface can warn when isolation is best-effort. */
  get runnerName(): string {
    return this.#runner.name;
  }

  async execute(action: ActionRequest): Promise<ExecOutcome> {
    if (action.type === "read" || action.type === "edit") {
      return this.#files.execute(action);
    }
    if (action.type === "command") {
      return this.#runCommand(action);
    }
    return {
      ok: false,
      error: `'${action.type}' is not executable locally (outward-facing action)`,
    };
  }

  async #runCommand(action: ActionRequest): Promise<ExecOutcome> {
    const raw =
      action.payload &&
      typeof action.payload === "object" &&
      "command" in action.payload &&
      typeof action.payload.command === "string"
        ? action.payload.command
        : (action.target ?? "");
    let argv = raw.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) {
      return { ok: false, error: "command is empty" };
    }
    if (argv[0] === "git") argv = hardenGitArgv(argv);
    // The command runs IN the workspace — make sure it (and HOME) exist.
    try {
      mkdirSync(this.#root, { recursive: true });
    } catch {
      /* best-effort; spawn will surface a real failure */
    }
    const result = await this.#runner.run(argv, {
      cwd: this.#root,
      timeoutMs: this.#timeoutMs,
      env: this.#env,
      writableRoots: [this.#root, this.#home],
    });
    if (result.timedOut) {
      return {
        ok: false,
        error: `command timed out after ${this.#timeoutMs}ms`,
        ...(result.code !== null ? { exitCode: result.code } : {}),
      };
    }
    const ok = result.code === 0;
    const trimmed = result.stdout.trim();
    return {
      ok,
      ...(trimmed.length > 0 ? { output: trimmed } : {}),
      ...(ok
        ? {}
        : {
            error:
              result.stderr.trim() ||
              `command exited with code ${String(result.code)}`,
          }),
      ...(result.code !== null ? { exitCode: result.code } : {}),
    };
  }
}
