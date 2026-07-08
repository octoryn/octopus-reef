/**
 * The conductor — Reef's governed multi-agent orchestrator.
 *
 * The Octoryn agent is NOT another coding agent; it is a dispatcher /
 * coordinator / translator that stands ABOVE a fleet of specialist workers
 * (our own, or a wrapped Claude Code / Codex / Gemini / an MCP tool / an API)
 * and (1) plans a task into subtasks, (2) ROUTES each to the best worker —
 * every routing decision recorded as evidence, (3) runs each as a governed
 * sub-session, and (4) stitches the whole thing into a **Worker Ledger**: one
 * tamper-evident, independently-verifiable chain that pins each sub-session, so
 * you can PROVE what a heterogeneous fleet of agents did — even agents we didn't
 * write. The moat is not the routing (that commoditises); it is the *provable*
 * orchestration.
 *
 * What we can prove is scoped honestly to the sub-session boundary (each
 * worker's governed effects + our own plan/route/acceptance records) — not a
 * black-box agent's internal reasoning.
 */
import {
  canonicalHash,
  chainHead,
  createEvidence,
  nextLink,
  verifyChain,
  verifyEvidence,
  type ChainLink,
  type Evidence,
  type JsonValue,
} from "octopus-evidence";
import type { SessionOutcome } from "@octopus-reef/engine";
import type { ModelProvider } from "./provider.js";

/** A unit of work the planner produced. */
export interface Subtask {
  readonly id: string;
  readonly description: string;
}

/** The proof-bearing result of running a worker on a subtask. */
export interface WorkerResult {
  readonly outcome: SessionOutcome;
  /** The worker's answer / summary (its `done` message). */
  readonly output: string;
  /** The governed sub-session's identity — pinned so an auditor can re-verify it. */
  readonly workHead: string;
  readonly logHead: string;
  readonly verified: boolean;
}

/** A specialist worker: does a subtask under governance, returns result + proof. */
export interface Worker {
  readonly name: string;
  /** What this worker is good for — the router reads this to choose. */
  readonly description: string;
  run(subtask: string): Promise<WorkerResult>;
}

/** Breaks a task into ordered subtasks. */
export interface Planner {
  plan(task: string): Promise<readonly Subtask[]>;
}

/** Chooses a worker for a subtask (the routing decision). */
export interface Router {
  route(
    subtask: string,
    workers: readonly Worker[],
  ): Promise<{ readonly worker: string; readonly reason: string }>;
}

/** One recorded step: the subtask, who it was routed to and why, and the result. */
export interface OrchestrationStep {
  readonly subtask: Subtask;
  readonly worker: string;
  readonly reason: string;
  readonly result: WorkerResult;
}

/** The Worker Ledger: the tamper-evident record of the whole orchestration. */
export interface WorkerLedger {
  readonly evidence: readonly Evidence[];
  readonly chain: readonly ChainLink[];
}

/** The final acceptance ruling, when an acceptance seam is wired. */
export interface Acceptance {
  readonly met: boolean;
  readonly reason: string;
}

/**
 * The acceptance / "translator" seam — how the conductor connects to
 * `octopus-intent` WITHOUT this package depending on it (keeping the checker a
 * consumer of the conductor's output, not a dependency). The caller mints an
 * Acceptance Contract from the task (octopus-intent `authorContract`) and passes
 * its hash (and optionally the contract itself) to be pinned in the ledger, plus
 * a `judge` that decides acceptance (e.g. running octopus-intent `checkContract`
 * over the produced sub-sessions). What is recorded: the contract the run was
 * held to, and the verdict against it — so the whole run is provable end to end.
 */
export interface AcceptanceSeam {
  /** The machine-checkable contract's hash (pinned; drift is then detectable). */
  readonly contractHash?: string;
  /** Optional full contract content to record for the auditor. */
  readonly contract?: JsonValue;
  /** Decide whether the orchestration met the contract. */
  readonly judge?: (
    task: string,
    steps: readonly OrchestrationStep[],
  ) => Promise<Acceptance>;
}

export interface OrchestrationResult {
  readonly outcome: "completed" | "partial" | "failed";
  readonly steps: readonly OrchestrationStep[];
  /** The tamper-evident ledger of plan + routing verdicts + pinned sub-sessions. */
  readonly ledger: WorkerLedger;
  /** Whether the ledger itself independently verifies (must be true). */
  readonly verified: boolean;
  /** The acceptance ruling, if an acceptance seam was wired. */
  readonly accepted?: Acceptance;
}

export interface OrchestratorOptions {
  readonly workers: readonly Worker[];
  readonly planner: Planner;
  readonly router: Router;
  /** Deterministic clock for reproducible ledgers/tests. */
  readonly now?: () => string;
  /** Keyed mode: HMAC-bind the ledger so it can't be forged. */
  readonly integritySecret?: string;
  /** Wire acceptance (the octopus-intent contract + verdict), decoupled. */
  readonly acceptance?: AcceptanceSeam;
}

/**
 * Independently re-verify a Worker Ledger store-untrusting: every entry
 * recomputes its id + integrity, each link commits its entry, and the chain is
 * contiguous. Verify with the same secret it was built with.
 */
export function verifyLedger(ledger: WorkerLedger, secret?: string): boolean {
  const { evidence, chain } = ledger;
  if (evidence.length !== chain.length) return false;
  for (let i = 0; i < evidence.length; i++) {
    if (!verifyEvidence(evidence[i]!, secret)) return false;
    if (chain[i]!.contentHash !== evidence[i]!.id) return false;
  }
  const cv = verifyChain(chain, secret !== undefined ? { secret } : {});
  return cv.ok;
}

export class Orchestrator {
  readonly #workers: readonly Worker[];
  readonly #planner: Planner;
  readonly #router: Router;
  readonly #now: () => string;
  readonly #secret: string | undefined;
  readonly #acceptance: AcceptanceSeam | undefined;

  constructor(options: OrchestratorOptions) {
    this.#workers = options.workers;
    this.#planner = options.planner;
    this.#router = options.router;
    this.#now = options.now ?? ((): string => new Date().toISOString());
    this.#secret = options.integritySecret;
    this.#acceptance = options.acceptance;
  }

  async orchestrate(task: string): Promise<OrchestrationResult> {
    const evidence: Evidence[] = [];
    const chain: ChainLink[] = [];
    const record = (kind: string, content: JsonValue): void => {
      const ev = createEvidence(
        {
          kind,
          subject: [
            { type: "orchestration", id: canonicalHash(task).slice(0, 16) },
          ],
          content,
          provenance: {
            source: "octopus-orchestrator",
            method: "orchestrate",
            at: this.#now(),
          },
        },
        this.#secret !== undefined ? { integritySecret: this.#secret } : {},
      );
      const link = nextLink(chain, ev.id, this.#secret);
      evidence.push(ev);
      chain.push(link);
    };

    const subtasks = await this.#planner.plan(task);
    record("orchestration.plan", {
      task,
      subtasks: subtasks.map((s) => ({ id: s.id, description: s.description })),
    });

    // Pin the Acceptance Contract (from octopus-intent) the run is held to, so
    // an auditor sees WHAT "done" means and can detect goalpost drift.
    if (
      this.#acceptance?.contractHash !== undefined ||
      this.#acceptance?.contract !== undefined
    ) {
      record("orchestration.contract", {
        ...(this.#acceptance.contractHash !== undefined
          ? { contractHash: this.#acceptance.contractHash }
          : {}),
        ...(this.#acceptance.contract !== undefined
          ? { contract: this.#acceptance.contract }
          : {}),
      });
    }

    const steps: OrchestrationStep[] = [];
    for (const subtask of subtasks) {
      const decision = await this.#route(subtask);
      record("orchestration.route", {
        subtaskId: subtask.id,
        worker: decision.worker.name,
        reason: decision.reason,
      });

      const result = await decision.worker.run(subtask.description);
      record("orchestration.result", {
        subtaskId: subtask.id,
        worker: decision.worker.name,
        outcome: result.outcome,
        output: result.output,
        // pin the exact sub-session so an auditor can re-verify it (swap-proof)
        workHead: result.workHead,
        logHead: result.logHead,
        verified: result.verified,
      });
      steps.push({
        subtask,
        worker: decision.worker.name,
        reason: decision.reason,
        result,
      });
    }

    const completed = steps.filter(
      (s) => s.result.outcome === "completed",
    ).length;
    const outcome: OrchestrationResult["outcome"] =
      steps.length > 0 && completed === steps.length
        ? "completed"
        : completed > 0
          ? "partial"
          : "failed";

    // Adjudicate against the Acceptance Contract (via the caller's octopus-intent
    // judge) and record the verdict — the run is provable end to end.
    let accepted: Acceptance | undefined;
    if (this.#acceptance?.judge !== undefined) {
      accepted = await this.#acceptance.judge(task, steps);
      record("orchestration.acceptance", {
        met: accepted.met,
        reason: accepted.reason,
      });
    }

    record("orchestration.done", {
      outcome,
      subtasks: steps.length,
      completed,
      ...(accepted !== undefined ? { met: accepted.met } : {}),
    });

    const ledger: WorkerLedger = { evidence, chain };
    return {
      outcome,
      steps,
      ledger,
      verified: verifyLedger(ledger, this.#secret),
      ...(accepted !== undefined ? { accepted } : {}),
    };
  }

  /** Resolve the router's choice to a real worker; fall back to the first. */
  async #route(subtask: Subtask): Promise<{ worker: Worker; reason: string }> {
    const choice = await this.#router.route(subtask.description, this.#workers);
    const worker =
      this.#workers.find((w) => w.name === choice.worker) ?? this.#workers[0];
    if (worker === undefined) {
      throw new Error("no workers registered");
    }
    const reason =
      worker.name === choice.worker
        ? choice.reason
        : `${choice.reason} (router picked "${choice.worker}"; fell back to "${worker.name}")`;
    return { worker, reason };
  }
}

/** The head of a ledger's chain (for pinning / anchoring). */
export function ledgerHead(ledger: WorkerLedger): string {
  return chainHead(ledger.chain);
}

// --- LLM-backed planner + router (rent the model through the provider seam) ---

function firstJson(text: string, open: "[" | "{"): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** A planner that asks the model to decompose the task into subtasks (JSON). */
export class LlmPlanner implements Planner {
  readonly #provider: ModelProvider;
  constructor(provider: ModelProvider) {
    this.#provider = provider;
  }
  async plan(task: string): Promise<readonly Subtask[]> {
    const resp = await this.#provider.complete({
      system:
        "You are a planner. Break the user's task into a short ordered list of " +
        "concrete subtasks. Reply ONLY with a JSON array of strings, no prose.",
      messages: [{ role: "user", content: task }],
      tools: [],
      maxTokens: 1024,
    });
    const raw = firstJson(textOf(resp.content), "[");
    let items: unknown = [];
    if (raw !== null) {
      try {
        items = JSON.parse(raw);
      } catch {
        items = [];
      }
    }
    const list = Array.isArray(items) && items.length > 0 ? items : [task];
    return list.map((d, i) => ({ id: `st${i + 1}`, description: String(d) }));
  }
}

/** A router that asks the model to pick a worker by name for a subtask (JSON). */
export class LlmRouter implements Router {
  readonly #provider: ModelProvider;
  constructor(provider: ModelProvider) {
    this.#provider = provider;
  }
  async route(
    subtask: string,
    workers: readonly Worker[],
  ): Promise<{ worker: string; reason: string }> {
    const menu = workers.map((w) => `- ${w.name}: ${w.description}`).join("\n");
    const resp = await this.#provider.complete({
      system:
        "You are a router. Choose the single best worker for the subtask. " +
        'Reply ONLY with JSON: {"worker":"<name>","reason":"<why>"}.',
      messages: [
        { role: "user", content: `Workers:\n${menu}\n\nSubtask: ${subtask}` },
      ],
      tools: [],
      maxTokens: 512,
    });
    const raw = firstJson(textOf(resp.content), "{");
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as {
          worker?: unknown;
          reason?: unknown;
        };
        if (typeof parsed.worker === "string") {
          return {
            worker: parsed.worker,
            reason:
              typeof parsed.reason === "string" ? parsed.reason : "(no reason)",
          };
        }
      } catch {
        /* fall through */
      }
    }
    return { worker: workers[0]?.name ?? "", reason: "router fallback" };
  }
}
