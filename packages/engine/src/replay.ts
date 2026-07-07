/**
 * Replay — byte-for-byte session reconstruction from the evidence log (M6).
 *
 * The positioning claim Reef must actually keep: a governed session is not just
 * verifiable, it is *replayable*. {@link replaySession} loads a persisted session,
 * independently re-verifies it store-untrusting (both chains AND their
 * cross-binding, via {@link loadSession}), then reconstructs the entire
 * fine-grained `ReefEvent` timeline from the verified log — deterministically and
 * totally. Because every event was minted as Evidence whose `content` carries its
 * `kind`/`summary`/`data` and whose `provenance.at` carries its timestamp, the
 * reconstruction is exact: replaying a session yields the same events the session
 * emitted live, and it can only succeed on a log that verifies.
 */
import { EngineError } from "./json.js";
import { loadSession, type PersistOptions } from "./persist.js";
import type { LogRecord } from "./log.js";
import type { ReefEvent, ReefEventKind, WorkState } from "./types.js";

const VALID_KINDS: ReadonlySet<string> = new Set<ReefEventKind>([
  "session.created",
  "work.transition",
  "observation",
  "action.executed",
  "action.denied",
  "message",
  "session.sealed",
]);

/**
 * Reconstruct the ordered {@link ReefEvent} timeline from verified log records.
 * Each event's `seq` is its position; its `evidenceId` is the record's Evidence
 * id; its `kind`/`summary`/`data` come from the Evidence `content`; its `at`
 * from the Evidence `provenance`. Rejects a record whose payload isn't a
 * well-formed Reef event (defence against a hand-forged but chain-valid log).
 */
export function reconstructEvents(records: readonly LogRecord[]): ReefEvent[] {
  return records.map((record, seq) => {
    const content: unknown = record.evidence.content;
    if (
      typeof content !== "object" ||
      content === null ||
      Array.isArray(content)
    ) {
      throw new EngineError(
        `log record ${seq} has a non-object content payload`,
      );
    }
    const { kind, summary, ...data } = content as Record<string, unknown>;
    if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
      throw new EngineError(
        `log record ${seq} has an invalid event kind: ${String(kind)}`,
      );
    }
    if (typeof summary !== "string") {
      throw new EngineError(`log record ${seq} is missing its summary`);
    }
    return {
      seq,
      kind: kind as ReefEventKind,
      at: record.evidence.provenance.at,
      evidenceId: record.evidence.id,
      summary,
      data: data as Readonly<Record<string, unknown>>,
    };
  });
}

export interface ReplayedSession {
  /** The full session timeline, reconstructed byte-for-byte from the log. */
  readonly events: readonly ReefEvent[];
  readonly workState: WorkState | undefined;
  readonly workChainLength: number;
  readonly logChainLength: number;
  /** `true` only when replayed in keyed mode — see {@link loadSession}. */
  readonly authenticated: boolean;
}

/**
 * Replay a persisted session: independently re-verify it store-untrusting, then
 * reconstruct its full evidence timeline. Throws {@link EngineError} (via
 * {@link loadSession}) if the log, the work spine, or their cross-binding fails —
 * a session that does not verify cannot be replayed.
 */
export function replaySession(
  dir: string,
  options: PersistOptions = {},
): ReplayedSession {
  const loaded = loadSession(dir, options);
  return {
    events: reconstructEvents(loaded.log.records()),
    workState: loaded.workState,
    workChainLength: loaded.workChainLength,
    logChainLength: loaded.logChainLength,
    authenticated: loaded.authenticated,
  };
}
