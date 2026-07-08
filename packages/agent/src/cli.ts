/**
 * CLI worker — wrap an EXTERNAL agent CLI (Claude Code, Codex, Gemini, …) as a
 * governed {@link Worker}, so the conductor can route work to agents we did not
 * write and still PROVE what they did.
 *
 * An external agent CLI is a trusted local tool that needs the network and its
 * own auth, so — unlike our own workers — we do NOT run it in the no-network OS
 * sandbox. Instead we run it confined to a workspace directory and capture its
 * file EFFECTS: a before/after content-hash diff of the workspace, recorded as
 * evidence. So the governed sub-session proves the invocation + exactly which
 * files the agent created / modified / deleted — a tamper-evident record of its
 * effects, honestly scoped (we do not claim to prove its internal reasoning).
 *
 * The command is configurable (`buildArgv`), so one seam wraps any agent CLI.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalHash } from "octopus-evidence";
import {
  GovernedSession,
  ToolExecutor,
  reefAllowlist,
  type ActionResult,
  type Driver,
  type DriverContext,
  type DriverStep,
  type ReefEvent,
  type Tool,
} from "@octopus-reef/engine";
import type { Worker, WorkerResult } from "./orchestrator.js";

const SKIP = new Set([".git", "node_modules", ".DS_Store"]);

/** Content-hash every file under `root` (skipping vcs/deps), keyed by rel path. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          out.set(
            relative(root, p),
            createHash("sha256").update(readFileSync(p)).digest("hex"),
          );
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  };
  walk(root);
  return out;
}

export interface FileChange {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly hash?: string;
}

function diff(
  before: Map<string, string>,
  after: Map<string, string>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const [p, h] of after) {
    const b = before.get(p);
    if (b === undefined) changes.push({ path: p, status: "added", hash: h });
    else if (b !== h) changes.push({ path: p, status: "modified", hash: h });
  }
  for (const p of before.keys()) {
    if (!after.has(p)) changes.push({ path: p, status: "deleted" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export interface CliRunResult {
  readonly exitCode: number | null;
  readonly changed: readonly FileChange[];
  readonly stdout: string;
  readonly timedOut: boolean;
}

/** Run `argv` in `cwd`, returning its exit + the file effects it produced. */
export function runCliWithDiff(
  argv: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
): CliRunResult {
  const before = snapshot(cwd);
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd ?? "", args, {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const after = snapshot(cwd);
  return {
    exitCode: r.status,
    changed: diff(before, after),
    stdout: (r.stdout ?? "").slice(0, 8000),
    timedOut:
      (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

/** A tool that runs an external CLI and reports its file effects. */
function cliTool(cwd: string, timeoutMs: number): Tool {
  return {
    name: "cli",
    description:
      "Run an external agent CLI, capturing its workspace file effects.",
    inputSchema: {
      type: "object",
      properties: { argv: { type: "array", items: { type: "string" } } },
      required: ["argv"],
    },
    run: (input) => {
      const argv = ((input as { argv?: unknown }).argv ?? []) as string[];
      const res = runCliWithDiff(argv, cwd, timeoutMs);
      const ok = res.exitCode === 0 && !res.timedOut;
      return Promise.resolve({
        ok,
        output: JSON.stringify({
          exitCode: res.exitCode,
          changed: res.changed,
          stdoutTail: res.stdout.slice(-1200),
        }),
        ...(ok
          ? {}
          : {
              error: `cli exited ${res.exitCode}${res.timedOut ? " (timeout)" : ""}`,
            }),
      });
    },
  };
}

/** A driver that dispatches to an external CLI and records its file effects. */
class CliDriver implements Driver {
  readonly name = "cli-driver";
  readonly #argv: readonly string[];
  readonly #label: string;

  constructor(argv: readonly string[], label: string) {
    this.#argv = argv;
    this.#label = label;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    yield {
      type: "observe",
      summary: `dispatching to ${this.#label}: "${ctx.task}"`,
    };
    const result = (yield {
      type: "action",
      action: {
        type: "tool",
        summary: `run ${this.#label}`,
        payload: { tool: "cli", input: { argv: this.#argv } },
      },
    }) as ActionResult | undefined;

    if (
      result === undefined ||
      !result.executed ||
      result.error !== undefined
    ) {
      yield {
        type: "fail",
        summary: `${this.#label} failed: ${result?.error ?? result?.reason ?? "no result"}`,
      };
      return;
    }
    // Record the file effects as evidence (an observation over the diff), so the
    // sub-session proves exactly what the external agent changed.
    let changed: FileChange[] = [];
    try {
      const parsed = JSON.parse(result.output ?? "{}") as {
        changed?: FileChange[];
      };
      if (Array.isArray(parsed.changed)) changed = parsed.changed;
    } catch {
      /* keep empty */
    }
    yield {
      type: "observe",
      summary: `${this.#label} changed ${changed.length} file(s)`,
      data: { changed },
    };
    yield { type: "done", summary: `${this.#label} completed "${ctx.task}"` };
  }
}

/** The worker's answer + its sub-session proof. */
async function runToResult(session: GovernedSession): Promise<WorkerResult> {
  const { outcome, events } = await session.run();
  const rev = [...events].reverse();
  const reason = rev.find((e: ReefEvent) => e.kind === "session.sealed")?.data[
    "reason"
  ];
  const output =
    typeof reason === "string" && reason.length > 0
      ? reason
      : (rev.find((e: ReefEvent) => e.kind === "message")?.summary ?? "");
  return {
    outcome,
    output,
    workHead: session.graph.anchor().head,
    logHead: session.log.head,
    verified: session.verify().ok,
  };
}

export interface CliWorkerOptions {
  readonly name: string;
  readonly description: string;
  /** The directory the CLI operates in (its effects are diffed here). */
  readonly workspace: string;
  /**
   * Build the argv to run for a subtask. Examples:
   *   claude: (t) => ["claude", "-p", t, "--permission-mode", "acceptEdits"]
   *   codex:  (t) => ["codex", "exec", "--full-auto", t]
   */
  readonly buildArgv: (subtask: string) => readonly string[];
  readonly timeoutMs?: number;
  readonly now?: () => string;
  readonly integritySecret?: string;
}

/** Wrap an external agent CLI (Claude Code / Codex / …) as a governed worker. */
export function cliWorker(options: CliWorkerOptions): Worker {
  return {
    name: options.name,
    description: options.description,
    run(subtask): Promise<WorkerResult> {
      const argv = options.buildArgv(subtask);
      const session = new GovernedSession({
        id: `${options.name}-${canonicalHash(subtask).slice(0, 10)}`,
        task: subtask,
        driver: new CliDriver(argv, options.name),
        authorizer: reefAllowlist({ tools: ["cli"] }),
        executor: new ToolExecutor([
          cliTool(options.workspace, options.timeoutMs ?? 120_000),
        ]),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.integritySecret !== undefined
          ? { integritySecret: options.integritySecret }
          : {}),
      });
      return runToResult(session);
    },
  };
}
