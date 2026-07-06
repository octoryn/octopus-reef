/**
 * Cross-binding verification — the guarantee that a session's two records
 * belong to *each other*, not just that each is internally intact.
 *
 * The evidence log and the work spine are separately tamper-evident, but that is
 * not enough: without binding, one session's log could be swapped under another
 * session's work spine and each half would still verify. `verifyBinding` closes
 * that gap by checking, at verify/load time:
 *
 *   1. the work spine holds exactly the session's one work item;
 *   2. every evidence in the log is *about* that work item (subject binding);
 *   3. the log ends with a `session.sealed` event (so a truncated tail is caught);
 *   4. that seal's declared `finalLogLength` equals the actual log length;
 *   5. that seal's declared `workAnchor` (length + head) equals the loaded work
 *      spine's anchor — cryptographically binding the log to *this* spine's
 *      content, so a swapped or rolled-back spine is rejected.
 */
import type { WorkStateGraph } from "octopus-workstate";
import type { EvidenceLog } from "./log.js";

export interface BindingResult {
  readonly ok: boolean;
  readonly reason: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function verifyBinding(
  graph: WorkStateGraph,
  log: EvidenceLog,
): BindingResult {
  const items = graph.items();
  if (items.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one work item, found ${items.length}`,
    };
  }
  const workItemId = items[0]!.id;

  const evidences = log.evidences();
  if (evidences.length === 0) {
    return { ok: false, reason: "empty evidence log" };
  }

  for (let i = 0; i < evidences.length; i++) {
    const boundToItem = evidences[i]!.subject.some(
      (r) => r.type === "work-item" && r.id === workItemId,
    );
    if (!boundToItem) {
      return {
        ok: false,
        reason: `evidence ${i} is not bound to work item ${workItemId} (foreign log)`,
      };
    }
  }

  const seal = evidences[evidences.length - 1]!;
  const content = asRecord(seal.content);
  if (content === undefined || content.kind !== "session.sealed") {
    return {
      ok: false,
      reason:
        "log does not end with a session.sealed event (truncated tail or unsealed)",
    };
  }
  if (content.finalLogLength !== log.length) {
    return {
      ok: false,
      reason: `seal declares ${String(content.finalLogLength)} links but the log has ${log.length}`,
    };
  }
  if (content.workItemId !== workItemId) {
    return {
      ok: false,
      reason: "seal's work item id does not match the work spine",
    };
  }
  const anchor = graph.anchor();
  const workAnchor = asRecord(content.workAnchor);
  if (
    workAnchor === undefined ||
    workAnchor.length !== anchor.length ||
    workAnchor.head !== anchor.head
  ) {
    return {
      ok: false,
      reason:
        "seal's work-spine anchor does not match the loaded spine (swapped or truncated work spine)",
    };
  }
  return { ok: true, reason: "bound" };
}
