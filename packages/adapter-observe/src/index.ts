/**
 * @octopus-reef/adapter-observe — the Reef INPUT boundary.
 *
 * A governed session is only as trustworthy as what enters it. This adapter uses
 * `octopus-observe` to turn an UNTRUSTED agent input (an MCP tool call, an agent
 * action) into a validated, canonical, immutable {@link Observation} — and, on
 * acceptance, bridges it to `octopus-evidence` Evidence, the same primitive a
 * Reef session records. A malformed input is REJECTED at the boundary and never
 * becomes evidence.
 *
 * The intended wiring: an ingesting driver routes each external input through
 * {@link ingestToEvidence}; on acceptance it emits a Reef `observe` step
 * referencing the observation's id, so the session's evidence chain links to the
 * boundary observation it trusted.
 */
import {
  Observe,
  agentEventValidators,
  toEvidence,
  type Observation,
  type ObserveOptions,
  type Rejection,
} from "octopus-observe";

export {
  Observe,
  agentEventValidators,
  agentActionEvent,
  mcpToolCallEvent,
  toEvidence,
} from "octopus-observe";
export type { Observation } from "octopus-observe";

/** The evidence produced from a boundary observation (an `octopus-evidence` Evidence). */
export type BoundaryEvidence = ReturnType<typeof toEvidence>;

/**
 * An {@link Observe} pre-wired with the agent-event validators (tool calls and
 * agent actions) — the untrusted inputs a coding agent produces.
 */
export function agentBoundary(
  options: Omit<ObserveOptions, "validators"> = {},
): Observe {
  return new Observe({ ...options, validators: agentEventValidators });
}

/** The result of pushing one untrusted input through the boundary. */
export type BoundaryResult =
  | {
      readonly status: "accepted" | "duplicate";
      readonly observation: Observation;
      readonly evidence: BoundaryEvidence;
    }
  | { readonly status: "rejected"; readonly rejection: Rejection }
  /** No validator claimed the event's kind — nothing was observed. */
  | { readonly status: "skipped"; readonly reason: string };

/**
 * Ingest an untrusted agent input through the observe boundary. On acceptance
 * the canonical observation is bridged to evidence (optionally HMAC-keyed with
 * `secret`); a malformed input is rejected and an unrecognised kind is skipped —
 * in neither case is any evidence minted.
 */
export async function ingestToEvidence(
  observe: Observe,
  input: unknown,
  secret?: string,
): Promise<BoundaryResult> {
  const result = await observe.ingest(input);
  if (result.status === "rejected") {
    return { status: "rejected", rejection: result.rejection };
  }
  if (result.status === "skipped") {
    return { status: "skipped", reason: result.reason };
  }
  return {
    status: result.status,
    observation: result.observation,
    evidence: toEvidence(
      result.observation,
      secret !== undefined ? { integritySecret: secret } : {},
    ),
  };
}
