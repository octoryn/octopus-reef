/**
 * GovernedSession — the core of Reef.
 *
 * It wraps an agent {@link Driver} and turns its work into a governed,
 * provable session by composing three Octopus primitives:
 *
 *   - `octopus-workstate` — the work spine. The task is a WorkItem that moves
 *     proposed → ready → claimed → in_progress → done, each move an
 *     evidence-chained StateTransition.
 *   - `octopus-evidence`  — the session record. Every moment (observation,
 *     action, gate ruling, message) is minted as Evidence on a tamper-evident
 *     chain (see {@link EvidenceLog}).
 *   - the {@link ActionGate} — every proposed action is ruled on before it runs.
 *
 * The result is the differentiator: a session you can independently verify and
 * replay, not a log you have to trust.
 */
import { WorkStateGraph, type Actor, type WorkState } from "octopus-workstate";
import type { JsonValue } from "octopus-evidence";
import { EvidenceLog } from "./log.js";
import { DefaultGate, type ActionGate } from "./gate.js";
import type {
  Driver,
  ReefEvent,
  ReefEventKind,
  SessionSnapshot,
} from "./types.js";

type JsonObject = { readonly [key: string]: JsonValue };

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
  /** Live event sink — a surface subscribes here to render the session. */
  readonly onEvent?: (event: ReefEvent) => void;
}

export interface SessionResult {
  readonly snapshot: SessionSnapshot;
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
  readonly #onEvent: ((event: ReefEvent) => void) | undefined;
  readonly #events: ReefEvent[] = [];
  #ran = false;

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

  /** Drive the session to completion. Idempotent guard: a session runs once. */
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

    for await (const step of this.#driver.run({
      sessionId: this.id,
      task: this.task,
    })) {
      if (step.type === "observe") {
        this.#emit("observation", step.summary, {
          ...(step.data ?? {}),
        } as JsonObject);
      } else if (step.type === "message") {
        this.#emit("message", step.text, {});
      } else if (step.type === "action") {
        const verdict = this.#gate.check(step.action);
        if (verdict.allow) {
          this.#emit("action.executed", step.action.summary, {
            actionType: step.action.type,
            ...(step.action.target !== undefined
              ? { target: step.action.target }
              : {}),
            policy: verdict.policy,
          });
        } else {
          this.#emit("action.denied", `DENIED: ${step.action.summary}`, {
            actionType: step.action.type,
            reason: verdict.reason,
            policy: verdict.policy,
          });
        }
      } else if (step.type === "done") {
        this.#advance("done", step.summary);
        break;
      }
    }

    // A driver that never yields `done` still gets sealed as done for provenance.
    if (this.#graph.get(this.workItemId)?.state === "in_progress") {
      this.#advance("done", "driver ended without an explicit done step");
    }

    this.#emit(
      "session.sealed",
      `session sealed · ${this.#log.length} evidence links`,
      {
        workState: this.workState,
        logHead: this.#log.head,
      },
    );

    return { snapshot: this.snapshot(), events: this.events };
  }

  get workState(): WorkState {
    return this.#graph.get(this.workItemId)?.state ?? "proposed";
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
      events: this.#events.length,
      workChainLength: this.#graph.auditChain().length,
      logChainLength: this.#log.length,
      logHead: this.#log.head,
      sealed: this.#events.some((e) => e.kind === "session.sealed"),
    };
  }

  /**
   * Independently verify BOTH chains store-untrusting: the work spine
   * (`octopus-workstate` audit trail) and the full session log
   * (`octopus-evidence` chain). A session is provable only if both are intact.
   */
  verify(): { ok: boolean; work: string; log: string } {
    const work = this.#graph.verify();
    const log = this.#log.verify();
    return {
      ok: work.ok && log.ok,
      work: work.ok ? "intact" : `broken: ${work.reason}`,
      log: log.ok ? "intact" : `broken: ${log.reason}`,
    };
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
    const { evidence } = this.#log.append({
      kind: `reef.${kind}`,
      subject: [{ type: "work-item", id: this.workItemId }],
      actor: { type: this.#actor.kind, id: this.#actor.id },
      content: { kind, summary, ...data },
      provenance: { source: "reef", method: "session", at },
    });
    const event: ReefEvent = {
      seq: this.#events.length,
      kind,
      at,
      evidenceId: evidence.id,
      summary,
      data,
    };
    this.#events.push(event);
    this.#onEvent?.(event);
  }
}
