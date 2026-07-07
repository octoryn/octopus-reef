/**
 * Sandboxed command execution (M1b-3) — the seam where an *authorized* command
 * actually runs, under OS confinement.
 *
 * After the 2026-07-06 incident, Reef never runs a real shell command on the
 * strength of a denylist. A command reaches {@link SandboxExecutor} only after
 * it has (1) passed the tripwire and (2) been authorized by the allowlist
 * (`reefAllowlist` — read-only binaries, no shell operators). The sandbox is the
 * THIRD, independent layer: even an allowlisted command runs
 *   - with NO shell (argv is spawned directly — operators can't be interpreted),
 *   - confined to the workspace (writes anywhere else are denied by the OS),
 *   - with the network denied,
 *   - under a hard timeout, and
 *   - with a scrubbed environment (no inherited secrets like API keys).
 *
 * On macOS this is enforced by `sandbox-exec`. On other platforms the process is
 * still cwd-confined, time-bounded, shell-free, and env-scrubbed, but OS-level
 * network/write isolation is best-effort — {@link SandboxExecutor} reports which
 * runner is active so a surface can warn. File `read`/`edit` is delegated to a
 * {@link WorkspaceExecutor}, so path confinement is identical to non-sandbox runs.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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

/** Runs a fully-formed argv. Injectable so tests never touch a real process. */
export interface CommandRunner {
  readonly name: string;
  run(
    argv: readonly string[],
    opts: {
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly env: Readonly<Record<string, string>>;
    },
  ): Promise<CommandResult>;
}

const OUTPUT_CAP = 16_000;

/** Spawn `cmd argv` with no shell, capture bounded output, enforce a timeout. */
function spawnCollect(
  cmd: string,
  args: readonly string[],
  opts: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly env: Readonly<Record<string, string>>;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: { ...opts.env },
      shell: false, // NEVER a shell — argv is literal, operators can't run
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString("utf8");
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

/**
 * An SBPL profile: allow by default, but DENY the network and DENY every
 * filesystem write except inside the workspace (plus the standard character
 * devices a normal process needs). "allow default" keeps ordinary binaries
 * working; the explicit denies are what confine the command.
 */
function darwinProfile(root: string): string {
  const esc = sbplEscape(root);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${esc}"))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero")' +
      ' (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")' +
      ' (literal "/dev/dtracehelper"))',
  ].join("\n");
}

/** macOS: wrap the command in `sandbox-exec` with the confinement profile. */
export const darwinSandboxRunner: CommandRunner = {
  name: "darwin-sandbox-exec",
  run(argv, opts) {
    const profile = darwinProfile(opts.cwd);
    return spawnCollect("sandbox-exec", ["-p", profile, ...argv], opts);
  },
};

/**
 * Non-macOS: cwd-confined, time-bounded, shell-free, env-scrubbed — but WITHOUT
 * OS network/write isolation. Safe here only because the command already passed
 * the read-only allowlist; surfaces should still warn (see {@link SandboxExecutor}).
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

/** A minimal environment — PATH/HOME/locale only, no inherited secrets. */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

export interface SandboxOptions {
  /** Override the process runner (tests inject a fake). */
  readonly runner?: CommandRunner;
  /** Hard timeout per command. Default 10s. */
  readonly timeoutMs?: number;
  /** Environment to pass to the command. Default: scrubbed PATH/HOME/locale. */
  readonly env?: Readonly<Record<string, string>>;
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
  readonly #files: WorkspaceExecutor;
  readonly #runner: CommandRunner;
  readonly #timeoutMs: number;
  readonly #env: Readonly<Record<string, string>>;

  constructor(root: string, options: SandboxOptions = {}) {
    this.#root = canonicalRoot(root);
    this.#files = new WorkspaceExecutor(root);
    this.#runner = options.runner ?? defaultRunner();
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#env = options.env ?? scrubbedEnv();
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
    const argv = raw.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) {
      return { ok: false, error: "command is empty" };
    }
    // The command runs IN the workspace — make sure it exists.
    try {
      mkdirSync(this.#root, { recursive: true });
    } catch {
      /* best-effort; spawn will surface a real failure */
    }
    const result = await this.#runner.run(argv, {
      cwd: this.#root,
      timeoutMs: this.#timeoutMs,
      env: this.#env,
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
