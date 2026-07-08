/**
 * Concrete workers for the {@link Orchestrator} — each wraps a governed
 * sub-session and returns a proof-bearing {@link WorkerResult} (its outcome, its
 * answer, and the sub-session's pinned heads). These two prove the seam over
 * HETEROGENEOUS workers; a wrapped external agent (Claude Code / Codex / …) is
 * just another `Worker` that runs under the same governance and pins the same
 * proof.
 */
import { canonicalHash } from "octopus-evidence";
import {
  GovernedSession,
  SandboxExecutor,
  ToolExecutor,
  reefAllowlist,
  type Tool,
} from "@octopus-reef/engine";
import { AgentWorker } from "./worker.js";
import { resultFromSession } from "./session-result.js";
import type { ModelProvider, ToolSpec } from "./provider.js";
import type { Worker, WorkerResult } from "./orchestrator.js";

interface CommonOptions {
  readonly provider: ModelProvider;
  readonly now?: () => string;
  readonly integritySecret?: string;
  readonly maxTurns?: number;
}

export interface CodeWorkerOptions extends CommonOptions {
  readonly name?: string;
  readonly description?: string;
  /** The sandbox workspace this worker edits + runs tests in. */
  readonly workspace: string;
  /** The command allowlist (build/test runners). */
  readonly commands?: Readonly<Record<string, readonly string[] | "*">>;
}

/** A worker that edits code + runs tests in a confined, sandboxed workspace. */
export function codeWorker(options: CodeWorkerOptions): Worker {
  const name = options.name ?? "code";
  const description =
    options.description ??
    "Reads, writes and fixes code and runs tests in a sandboxed workspace.";
  return {
    name,
    description,
    run(subtask): Promise<WorkerResult> {
      const session = new GovernedSession({
        id: `${name}-${canonicalHash(subtask).slice(0, 10)}`,
        task: subtask,
        driver: new AgentWorker({
          provider: options.provider,
          maxTurns: options.maxTurns ?? 30,
        }),
        authorizer: reefAllowlist({
          commands: options.commands ?? { node: "*", npm: ["test", "run"] },
        }),
        executor: new SandboxExecutor(options.workspace, { timeoutMs: 25_000 }),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.integritySecret !== undefined
          ? { integritySecret: options.integritySecret }
          : {}),
      });
      return resultFromSession(session);
    },
  };
}

export interface ToolWorkerOptions extends CommonOptions {
  readonly name?: string;
  readonly description?: string;
  /** The tools (MCP / HTTP / functions) this worker may call. */
  readonly tools: readonly Tool[];
}

/** A worker that uses tools/APIs (MCP, HTTP, functions) — no code editing. */
export function toolWorker(options: ToolWorkerOptions): Worker {
  const name = options.name ?? "tools";
  const description =
    options.description ??
    "Uses tools and APIs (MCP, HTTP, functions) to look things up and act.";
  const specs: ToolSpec[] = options.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const toolNames = options.tools.map((t) => t.name);
  return {
    name,
    description,
    run(subtask): Promise<WorkerResult> {
      const session = new GovernedSession({
        id: `${name}-${canonicalHash(subtask).slice(0, 10)}`,
        task: subtask,
        driver: new AgentWorker({
          provider: options.provider,
          tools: specs,
          maxTurns: options.maxTurns ?? 12,
        }),
        authorizer: reefAllowlist({ tools: toolNames }),
        executor: new ToolExecutor([...options.tools]),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.integritySecret !== undefined
          ? { integritySecret: options.integritySecret }
          : {}),
      });
      return resultFromSession(session);
    },
  };
}
