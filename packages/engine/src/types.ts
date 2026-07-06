/**
 * Public contracts for the Reef engine.
 *
 * A Reef session is a governed wrapper around an agent: every step the agent
 * takes becomes a {@link ReefEvent} minted as `octopus-evidence` and appended to
 * a tamper-evident chain, while the work itself moves through an
 * `octopus-workstate` provenance graph. The engine never reinvents hashing,
 * chains, or the work state machine — it composes them.
 */
import type { Actor, WorkState } from "octopus-workstate";

export type { Actor, WorkState };

/** The kinds of action an agent driver may propose during a session. */
export type ActionType =
  "read" | "search" | "edit" | "command" | "pr" | "message";

/** A single action an agent wants to take. Every action is gated before it runs. */
export interface ActionRequest {
  readonly type: ActionType;
  readonly summary: string;
  /** What the action operates on — a path, repo, or command target. */
  readonly target?: string;
  /** Structured payload (e.g. `{ command: "npm test" }`). */
  readonly payload?: Readonly<Record<string, unknown>>;
  /**
   * When `true`, the session cannot legitimately succeed without this action.
   * A *required* action that the gate denies fails the whole session (the work
   * moves to `failed`) rather than sealing as a misleading `done`.
   */
  readonly required?: boolean;
}

/** A gate's ruling on a proposed action. */
export interface GateVerdict {
  readonly allow: boolean;
  readonly reason: string;
  /** The name of the policy that produced the ruling. */
  readonly policy: string;
}

/** How a session ended. Only `completed` is a success. */
export type SessionOutcome = "completed" | "failed" | "cancelled";

/** The kinds of event a governed session emits, in evidence order. */
export type ReefEventKind =
  | "session.created"
  | "work.transition"
  | "observation"
  | "action.executed"
  | "action.denied"
  | "message"
  | "session.sealed";

/**
 * One recorded moment of a session. `evidenceId` is the id of the
 * `octopus-evidence` Evidence this event was minted as — the same value the
 * tamper-evident chain commits at position `seq`.
 */
export interface ReefEvent {
  readonly seq: number;
  readonly kind: ReefEventKind;
  readonly at: string;
  readonly evidenceId: string;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A single step produced by a {@link Driver} as it works a task. */
export type DriverStep =
  | {
      readonly type: "observe";
      readonly summary: string;
      readonly data?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "action"; readonly action: ActionRequest }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "fail"; readonly summary: string }
  | { readonly type: "done"; readonly summary: string };

/** What a driver is told about the session it is working. */
export interface DriverContext {
  readonly sessionId: string;
  readonly task: string;
}

/**
 * The agent behind a session. Reef is driver-agnostic: a {@link Driver} may be a
 * deterministic mock (offline, keyless), a Claude Agent SDK wrapper, or any
 * other engine. The governance substrate is identical regardless.
 */
export interface Driver {
  readonly name: string;
  run(ctx: DriverContext): AsyncIterable<DriverStep>;
}

/** A point-in-time projection of a session — what a surface renders. */
export interface SessionSnapshot {
  readonly id: string;
  readonly task: string;
  readonly workState: WorkState;
  readonly outcome: SessionOutcome;
  readonly events: number;
  readonly actionsExecuted: number;
  readonly actionsDenied: number;
  readonly workChainLength: number;
  readonly logChainLength: number;
  readonly logHead: string;
  readonly sealed: boolean;
}
