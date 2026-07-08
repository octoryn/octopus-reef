/**
 * Turn a finished governed sub-session into a proof-bearing {@link WorkerResult}
 * — its outcome, its answer, and its full tamper-evident record (so a judge can
 * `checkContract` over it). Shared by every worker so the record shape is built
 * one way.
 */
import { GovernedSession, type ReefEvent } from "@octopus-reef/engine";
import type { SessionRecord, WorkerResult } from "./orchestrator.js";

/** Extract the two chains a checker needs from a session. */
export function recordOf(session: GovernedSession): SessionRecord {
  const work = session.graph.exportAuditTrail();
  return {
    work: { evidence: work.evidence, chain: work.chain },
    log: {
      evidence: session.log.evidences(),
      chain: session.log.records().map((r) => r.link),
    },
  };
}

/** Run a session and package its proof-bearing result. */
export async function resultFromSession(
  session: GovernedSession,
): Promise<WorkerResult> {
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
    record: recordOf(session),
  };
}
