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
 * Honest scope: on macOS `sandbox-exec` denies network + out-of-root writes AND
 * denies reads of the entire real HOME (SSH keys, cloud creds, ~/.claude.json,
 * every other project), re-allowing only the workspace + the binary's toolchain.
 * That last part matters: git's config-driven code-execution surface (filter /
 * gpg / fsmonitor / textconv hooks in an untrusted repo's own config) is
 * UNBOUNDED — chasing it knob-by-knob is a losing game — so instead of trying to
 * stop the code running, we stop it reaching secrets. Executed code still runs,
 * but only against the workspace, with no network and no out-of-root write, so
 * it cannot exfiltrate. Reads of system paths (/usr, /etc, /tmp) stay allowed so
 * the toolchain works; that is the local sandbox's honest limit — STRONG
 * isolation of a fully untrusted repo is the container's job (Docker, M5). The
 * allowlist also excludes general file-read tools (cat/ls/grep) — reads go
 * through Reef's confined `read`/`search` actions. On non-macOS the process is
 * still cwd-confined, time-bounded, shell-free, and env-neutralised, but
 * OS-level network/read/write isolation is best-effort — {@link SandboxExecutor}
 * reports which runner is active so a surface can warn.
 */
import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
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
  /**
   * Directories to RE-ALLOW reads for after the real HOME is read-denied — the
   * workspace (which may itself live under HOME) plus the toolchain prefix of
   * the binary being run (e.g. a node under `~/.nvm`).
   */
  readonly readableRoots: readonly string[];
}

/** Runs a fully-formed argv. Injectable so tests never touch a real process. */
export interface CommandRunner {
  readonly name: string;
  run(argv: readonly string[], opts: RunOptions): Promise<CommandResult>;
}

const OUTPUT_CAP = 16_000;

/** Throwaway HOME dirs to remove when the process exits (temp-dir hygiene). */
const TEMP_HOMES = new Set<string>();
let exitHookInstalled = false;
function registerTempHome(dir: string): void {
  TEMP_HOMES.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const d of TEMP_HOMES) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort on exit */
      }
    }
  });
}

/**
 * Spawn `cmd argv` with no shell, in its own process group, capturing bounded
 * output and enforcing a timeout that kills the WHOLE group and RESOLVES — a
 * descendant that escaped the group (setsid) could otherwise hold the stdout
 * pipe open and 'close' would never fire, hanging the executor.
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
    let settled = false;
    const append = (buf: string, d: Buffer): string =>
      buf.length >= OUTPUT_CAP
        ? buf
        : buf + d.toString("utf8").slice(0, OUTPUT_CAP - buf.length);
    const finish = (code: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, timedOut });
    };
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal); // group gone / never formed — fall back to the child
      }
    };
    // Resolve on timeout even if a setsid-escaped descendant holds the pipe open.
    const timer = setTimeout(() => {
      killGroup("SIGKILL");
      finish(null, true);
    }, opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout = append(stdout, d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = append(stderr, d);
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (stderr.length < OUTPUT_CAP) stderr += err.message;
      finish(null, false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code, false);
    });
  });
}

/** Escape a path for inclusion in an `sandbox-exec` SBPL string literal. */
function sbplEscape(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * An SBPL profile: allow by default, but DENY the network, DENY every write
 * outside the workspace/home, and — critically — DENY all reads of the real
 * HOME, re-allowing only the workspace/home/toolchain.
 *
 * Reading is what turns a repo-config code-exec vector (git filter/gpg hooks —
 * an unbounded surface we deliberately DON'T try to enumerate) into a secret
 * exfiltration: the hook prints `~/.ssh/id_rsa` / `~/.aws` / `~/.claude.json`
 * back through the tool's output. Denying the whole real HOME (where those live,
 * along with every other project) contains it — executed code can still run, but
 * only against the workspace, with no network and no out-of-root write. Reads of
 * system paths (/usr, /etc, /tmp) stay allowed so the toolchain works; that is
 * the local sandbox's honest limit — full untrusted-repo isolation is the
 * container (M5). "allow default" keeps ordinary binaries working.
 */
function darwinProfile(
  writableRoots: readonly string[],
  readableRoots: readonly string[],
): string {
  const subpaths = (roots: readonly string[]): string =>
    roots.map((r) => `(subpath "${sbplEscape(r)}")`).join(" ");
  const home = homedir();
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* ${subpaths(writableRoots)})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero")' +
      ' (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")' +
      ' (literal "/dev/dtracehelper"))',
  ];
  if (home !== "" && home !== "/") {
    // Order matters: the re-allow comes AFTER the deny (last match wins in SBPL),
    // so a workspace/toolchain under HOME stays readable.
    lines.push(`(deny file-read* (subpath "${sbplEscape(home)}"))`);
    if (readableRoots.length > 0) {
      lines.push(`(allow file-read* ${subpaths(readableRoots)})`);
    }
  }
  return lines.join("\n");
}

/** macOS: wrap the command in `sandbox-exec` with the confinement profile. */
export const darwinSandboxRunner: CommandRunner = {
  name: "darwin-sandbox-exec",
  run(argv, opts) {
    const profile = darwinProfile(opts.writableRoots, opts.readableRoots);
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

/** Resolve a command name to its real executable path (via PATH), or undefined. */
function resolveBinary(
  name: string,
  pathEnv: string | undefined,
): string | undefined {
  try {
    if (name.includes("/")) return realpathSync(name);
    for (const dir of (pathEnv ?? "").split(delimiter)) {
      if (dir === "") continue;
      const candidate = join(dir, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return realpathSync(candidate);
      } catch {
        /* keep searching PATH */
      }
    }
  } catch {
    /* unresolved — caller falls back to no toolchain allow */
  }
  return undefined;
}

/** True if allowing reads of `p` would NOT re-open the read-denied HOME. */
function safeReadAllow(p: string, home: string): boolean {
  const rel = relative(p, home);
  // rel === "" → p is HOME; rel without ".." → HOME is *inside* p (an ancestor).
  return rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
}

/**
 * The narrowest toolchain directory to re-allow reads for so the binary at
 * `bin` can load its libraries, without ever re-opening HOME. Prefers the
 * install prefix (dirname²), falling back to the bin dir.
 */
function toolchainReadAllow(bin: string, home: string): string | undefined {
  const prefix = dirname(dirname(bin));
  if (safeReadAllow(prefix, home)) return prefix;
  const binDir = dirname(bin);
  if (safeReadAllow(binDir, home)) return binDir;
  return undefined;
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
    registerTempHome(this.#home);
    this.#env = sandboxEnv(this.#home);
  }

  /** Which runner is active — so a surface can warn when isolation is best-effort. */
  get runnerName(): string {
    return this.#runner.name;
  }

  /** The private throwaway HOME this executor runs commands with. */
  get homeDir(): string {
    return this.#home;
  }

  /** Remove this executor's throwaway HOME. Idempotent; call when done. */
  dispose(): void {
    TEMP_HOMES.delete(this.#home);
    try {
      rmSync(this.#home, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
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
    // Re-allow reads for the workspace, throwaway home, and the binary's
    // toolchain prefix (which may live under the read-denied real HOME).
    const bin = resolveBinary(argv[0]!, this.#env.PATH);
    const toolchain =
      bin !== undefined ? toolchainReadAllow(bin, homedir()) : undefined;
    const readableRoots = [
      this.#root,
      this.#home,
      ...(toolchain !== undefined ? [toolchain] : []),
    ];
    const result = await this.#runner.run(argv, {
      cwd: this.#root,
      timeoutMs: this.#timeoutMs,
      env: this.#env,
      writableRoots: [this.#root, this.#home],
      readableRoots,
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
