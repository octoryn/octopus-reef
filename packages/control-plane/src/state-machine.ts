import type { AgentRunStatus } from "./types.js";

const TRANSITIONS: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> =
  {
    QUEUED: [
      "PROVISIONING",
      "WAITING_FOR_REVIEW",
      "CANCELLED",
      "FAILED",
      "BUDGET_EXCEEDED",
    ],
    PROVISIONING: [
      "PLANNING",
      "WAITING_FOR_REVIEW",
      "FAILED",
      "CANCELLED",
      "BUDGET_EXCEEDED",
    ],
    PLANNING: [
      "RUNNING",
      "WAITING_FOR_REVIEW",
      "FAILED",
      "CANCELLED",
      "BUDGET_EXCEEDED",
    ],
    RUNNING: [
      "WAITING_FOR_TOOL",
      "VERIFYING",
      "WAITING_FOR_REVIEW",
      "FAILED",
      "CANCELLED",
      "BUDGET_EXCEEDED",
    ],
    WAITING_FOR_TOOL: [
      "RUNNING",
      "WAITING_FOR_REVIEW",
      "FAILED",
      "CANCELLED",
      "BUDGET_EXCEEDED",
    ],
    VERIFYING: [
      "RUNNING",
      "WAITING_FOR_REVIEW",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "BUDGET_EXCEEDED",
    ],
    WAITING_FOR_REVIEW: ["QUEUED", "VERIFYING", "FAILED", "CANCELLED"],
    COMPLETED: [],
    FAILED: ["QUEUED"],
    CANCELLED: ["QUEUED"],
    BUDGET_EXCEEDED: ["QUEUED"],
  };

export class InvalidRunTransitionError extends Error {
  constructor(from: AgentRunStatus, to: AgentRunStatus) {
    super(`invalid AgentRun transition: ${from} -> ${to}`);
    this.name = "InvalidRunTransitionError";
  }
}

export function canTransition(
  from: AgentRunStatus,
  to: AgentRunStatus,
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertRunTransition(
  from: AgentRunStatus,
  to: AgentRunStatus,
): void {
  if (!canTransition(from, to)) throw new InvalidRunTransitionError(from, to);
}

export const canStepTransition = canTransition;
export const assertStepTransition = assertRunTransition;

export function isTerminal(status: AgentRunStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "BUDGET_EXCEEDED"
  );
}
