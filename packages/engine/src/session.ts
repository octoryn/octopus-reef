/**
 * GovernedSession — the core of Reef.
 *
 * It wraps an agent {@link Driver} and turns its work into a governed, provable
 * session by composing three Octopus primitives:
 *
 *   - `octopus-workstate` — the work spine. The task is a WorkItem that moves
 *     proposed → ready → claimed → in_progress → {done | failed | cancelled},
 *     each move an evidence-chained StateTransition.
 *   - `octopus-evidence`  — the session record. Every moment (observation,
 *     action, gate ruling, message) is minted as Evidence on a tamper-evident
 *     chain (see {@link EvidenceLog}), and the sealing event anchors the work
 *     spine into the log so the two records are cross-bound (see verifyBinding).
 *   - the {@link ActionGate} — every proposed action is ruled on before it runs.
 *
 * The result is the differentiator: a session you can independently verify,
 * not a log you have to trust. A session that fails, is cancelled, or whose
 * driver errors is recorded *as such* — it never seals a misleading `done`.
 */
import { WorkStateGraph, type Actor, type WorkState } from "octopus-workstate";
import type { JsonValue } from "octopus-evidence";
import { EvidenceLog } from "./log.js";
import { DefaultGate, type ActionGate } from "./gate.js";
import { assertJsonObject, EngineError } from "./json.js";
import { verifyBinding } from "./verify.js";
import type {
  Driver,
  ReefEvent,
  ReefEventKind,
  SessionOutcome,
  SessionSnapshot,
} from "./types.js";

type JsonObject = { readonly [key: string]: JsonValue };

/** The terminal work state each outcome finalises to. */
const OUTCOME_STATE: Record<SessionOutcome, WorkState> = {
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export interface SessionOptions {
  readonly id: string;
  readonly task: string;
  readonly driver: Driver;
  /** Who is accountable for the work. Defaults to the driver, as an agent actor. */
  readonly actor?: Actor;
  readonly gate?: ActionGate;
  /** Keyed mode: bind every evidence and both chains tamper-evidently. */
  readonly integritySecret?: string;
  /** Clock injection for deterministic sessions/tests. */
  readonly now?: () => string;
  /** Cancel a running session; the work finalises as `cancelled`. */
  readonly signal?: AbortSignal;
  /** Live event sink — a surface subscribes here to render the session. */
  readonly onEvent?: (event: ReefEvent) => void;
}

export interface SessionResult {
  readonly snapshot: SessionSnapshot;
  readonly outcome: SessionOutcome;
  readonly events: readonly ReefEvent[];
}

export class GovernedSession {
  readonly id: string;
  readonly task: string;
  readonly workItemId: string;

  readonly #driver: Driver;
  readonly #gate: ActionGate;
  readonly #actor: Actor;
  readonly #graph: WorkStateGraph;
  readonly #log: EvidenceLog;
  readonly #now: () => string;
  readonly #signal: AbortSignal | undefined;
  readonly #onEvent: ((event: ReefEvent) => void) | undefined;
  readonly #events: ReefEvent[] = [];
  #ran = false;
  #outcome: SessionOutcome = "failed";
  #actionsExecuted = 0;
  #actionsDenied = 0;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.task = options.task;
    this.workItemId = `work-${options.id}`;
    this.#driver = options.driver;
    this.#gate = options.gate ?? new DefaultGate();
    this.#actor = options.actor ?? {
      id: options.driver.name,
      kind: "agent",
      source: "reef",
    };
    this.#now = options.now ?? ((): string => new Date().toISOString());
    this.#signal = options.signal;
    this.#onEvent = options.onEvent;
    const secret = options.integritySecret;
    this.#graph = new WorkStateGraph({
      now: this.#now,
      ...(secret !== undefined ? { integritySecret: secret } : {}),
    });
    this.#log = new EvidenceLog(
      secret !== undefined ? { integritySecret: secret } : {},
    );
  }

  /**
   * Drive the session to completion. Runs exactly once. Never throws for driver
   * failures — a driver error or an un-finished driver finalises the work as
   * `failed` and still produces a sealed, verifiable (failure) proof.
   */
  async run(): Promise<SessionResult> {
    if (this.#ran) throw new Error("session already ran");
    this.#ran = true;

    this.#emit("session.created", `session opened for "${this.task}"`, {
      driver: this.#driver.name,
      actor: this.#actor.id,
    });
    this.#graph.add({
      id: this.workItemId,
      title: this.task,
      origin: {
        originType: "manual",
        note: `opened in Reef by ${this.#actor.id}`,
      },
    });
    this.#advance("ready", "groomed: dependencies satisfied");
    this.#advance("claimed", "claimed by the working agent");
    this.#advance("in_progress", "agent started work");

    // Default is FAILURE. A session is only `completed` if the driver explicitly
    // says so with a `done` step. This prevents a silent/empty run from sealing
    // as a misleading success.
    let outcome: SessionOutcome | null = null;
    let reason = "driver ended without an explicit done step";

    try {
      for await (const step of this.#driver.run({
        sessionId: this.id,
        task: this.task,
      })) {
        if (this.#signal?.aborted) {
          outcome = "cancelled";
          reason = "session was cancelled";
          break;
        }
        if (step.type === "observe") {
          this.#emit(
            "observation",
            step.summary,
            step.data ? assertJsonObject(step.data, "step.data") : {},
          );
        } else if (step.type === "message") {
          this.#emit("message", step.text, {});
        } else if (step.type === "fail") {
          outcome = "failed";
          reason = step.summary;
          break;
        } else if (step.type === "action") {
          const verdict = this.#gate.check(step.action);
          if (verdict.allow) {
            this.#actionsExecuted++;
            this.#emit("action.executed", step.action.summary, {
              actionType: step.action.type,
              ...(step.action.target !== undefined
                ? { target: step.action.target }
                : {}),
              policy: verdict.policy,
            });
          } else {
            this.#actionsDenied++;
            this.#emit("action.denied", `DENIED: ${step.action.summary}`, {
              actionType: step.action.type,
              required: step.action.required === true,
              reason: verdict.reason,
              policy: verdict.policy,
            });
            if (step.action.required === true) {
              outcome = "failed";
              reason = `a required action was denied by the gate: ${step.action.summary}`;
              break;
            }
          }
        } else if (step.type === "done") {
          outcome = "completed";
          reason = step.summary;
          break;
        }
      }
    } catch (err) {
      outcome = "failed";
      reason = `driver error: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (outcome === null) outcome = "failed";
    this.#finalize(outcome, reason);
    return { snapshot: this.snapshot(), outcome, events: this.events };
  }

  get workState(): WorkState {
    return this.#graph.get(this.workItemId)?.state ?? "proposed";
  }

  get outcome(): SessionOutcome {
    return this.#outcome;
  }

  get events(): readonly ReefEvent[] {
    return this.#events;
  }

  get graph(): WorkStateGraph {
    return this.#graph;
  }

  get log(): EvidenceLog {
    return this.#log;
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      task: this.task,
      workState: this.workState,
      outcome: this.#outcome,
      events: this.#events.length,
      actionsExecuted: this.#actionsExecuted,
      actionsDenied: this.#actionsDenied,
      workChainLength: this.#graph.auditChain().length,
      logChainLength: this.#log.length,
      logHead: this.#log.head,
      sealed: this.#events.some((e) => e.kind === "session.sealed"),
    };
  }

  /**
   * Independently verify the session store-untrusting: the work spine
   * (`octopus-workstate`), the evidence log (`octopus-evidence`), AND that the
   * two are cross-bound to each other (see {@link verifyBinding}). A session is
   * provable only if all three hold.
   */
  verify(): { ok: boolean; work: string; log: string; binding: string } {
    const work = this.#graph.verify();
    const log = this.#log.verify();
    const binding = verifyBinding(this.#graph, this.#log);
    return {
      ok: work.ok && log.ok && binding.ok,
      work: work.ok ? "intact" : `broken: ${work.reason}`,
      log: log.ok ? "intact" : `broken: ${log.reason}`,
      binding: binding.ok ? "bound" : `broken: ${binding.reason}`,
    };
  }

  /** Finalise the work to the terminal for `outcome`, then seal the log. */
  #finalize(outcome: SessionOutcome, reason: string): void {
    this.#outcome = outcome;
    this.#advance(OUTCOME_STATE[outcome], reason);
    const anchor = this.#graph.anchor();
    this.#emit(
      "session.sealed",
      `session sealed · ${outcome} · ${this.#log.length + 1} evidence links`,
      {
        outcome,
        reason,
        workItemId: this.workItemId,
        finalLogLength: this.#log.length + 1,
        workAnchor: { length: anchor.length, head: anchor.head },
        actionsExecuted: this.#actionsExecuted,
        actionsDenied: this.#actionsDenied,
      },
    );
  }

  #advance(to: WorkState, reason: string): void {
    const transition = this.#graph.transition(this.workItemId, to, {
      by: this.#actor,
      reason,
    });
    this.#emit("work.transition", `${transition.from ?? "∅"} → ${to}`, {
      from: transition.from,
      to,
      transitionEvidenceId: transition.evidenceId,
      sequence: transition.sequence,
    });
  }

  #emit(kind: ReefEventKind, summary: string, data: JsonObject): void {
    const at = this.#now();
    let evidenceId: string;
    try {
      const record = this.#log.append({
        kind: `reef.${kind}`,
        subject: [{ type: "work-item", id: this.workItemId }],
        actor: { type: this.#actor.kind, id: this.#actor.id },
        content: { kind, summary, ...data },
        provenance: { source: "reef", method: "session", at },
      });
      evidenceId = record.evidence.id;
    } catch (err) {
      throw new EngineError(
        `failed to mint evidence for ${kind}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const event: ReefEvent = {
      seq: this.#events.length,
      kind,
      at,
      evidenceId,
      summary,
      data,
    };
    this.#events.push(event);
    this.#onEvent?.(event);
  }
}
