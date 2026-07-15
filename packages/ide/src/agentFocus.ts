import type {
  ReefEvent,
  UsageSummaryResponse,
  VerifyResult,
} from "@octopus-reef/protocol";

export interface FocusEvidenceItem {
  readonly seq: number;
  readonly kind: string;
  readonly label: string;
  readonly summary: string;
  readonly evidenceId: string;
  readonly tone: "neutral" | "ok" | "bad";
}

export interface FocusActionItem {
  readonly type: string;
  readonly summary: string;
  readonly target?: string;
  readonly command?: string;
  readonly tone: "ok" | "bad";
}

export interface FocusUsageSnapshot {
  readonly calls: number;
  readonly totalTokens: number;
  readonly cost: string;
  readonly summary: string;
  readonly remaining: string;
}

export interface FocusRunView {
  readonly task: string;
  readonly plan: readonly string[];
  readonly actions: readonly FocusActionItem[];
  readonly evidence: readonly FocusEvidenceItem[];
  readonly diff: string;
  readonly verifyTone: "ok" | "bad" | "pending";
  readonly verifyLabel: string;
  readonly usage: FocusUsageSnapshot;
}

const ZERO_USAGE: FocusUsageSnapshot = {
  calls: 0,
  totalTokens: 0,
  cost: "$0.000000",
  summary: "0 provider calls recorded for this governed session.",
  remaining: "Remaining balance: not available from the offline mock provider.",
};

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "session.created": "session",
  "work.transition": "work",
  observation: "observe",
  "action.executed": "action",
  "action.denied": "denied",
  message: "plan",
  "session.sealed": "sealed",
};

export function summarizeFocusEvent(event: ReefEvent): FocusEvidenceItem {
  return {
    seq: event.seq,
    kind: event.kind,
    label: EVENT_LABELS[event.kind] ?? event.kind,
    summary: event.summary,
    evidenceId: event.evidenceId,
    tone:
      event.kind === "action.denied"
        ? "bad"
        : event.kind === "action.executed" || event.kind === "session.sealed"
          ? "ok"
          : "neutral",
  };
}

export function extractFocusPlan(
  events: readonly ReefEvent[],
): readonly string[] {
  const plans = events
    .filter((event) => event.kind === "message")
    .map((event) => event.summary.replace(/^Plan:\s*/i, "").trim())
    .filter((line) => line !== "");
  return plans.length > 0 ? plans : ["Waiting for the governed plan."];
}

export function extractFocusActions(
  events: readonly ReefEvent[],
): readonly FocusActionItem[] {
  return events
    .filter(
      (event) =>
        event.kind === "action.executed" || event.kind === "action.denied",
    )
    .map((event) => {
      const type = stringField(event.data, "actionType") ?? "action";
      const target = stringField(event.data, "target");
      const payload = objectField(event.data, "payload");
      const command =
        payload !== undefined
          ? (stringField(payload, "command") ?? stringField(payload, "tool"))
          : undefined;
      return {
        type,
        summary: event.summary,
        ...(target !== undefined ? { target } : {}),
        ...(command !== undefined ? { command } : {}),
        tone: event.kind === "action.denied" ? "bad" : "ok",
      };
    });
}

export function focusVerifyTone(
  verify: VerifyResult | undefined,
): "ok" | "bad" | "pending" {
  if (verify === undefined) return "pending";
  return verify.ok ? "ok" : "bad";
}

export function focusVerifyLabel(verify: VerifyResult | undefined): string {
  if (verify === undefined) return "PENDING";
  return verify.ok
    ? `VERIFIED: work ${verify.work}, log ${verify.log}, binding ${verify.binding}`
    : `UNVERIFIED: work ${verify.work}, log ${verify.log}, binding ${verify.binding}`;
}

export function focusUsageSnapshot(
  usage: UsageSummaryResponse | undefined,
  sessionId: string | undefined,
): FocusUsageSnapshot {
  if (usage === undefined || sessionId === undefined) return ZERO_USAGE;
  const session = usage.sessions.find(
    (candidate) => candidate.id === sessionId,
  );
  const totals = session?.totals;
  const remaining = usage.remaining
    .map(
      (entry) =>
        `${entry.provider}: ${entry.status} (${entry.source}) - ${entry.message}`,
    )
    .join(" | ");
  if (totals === undefined) {
    return {
      ...ZERO_USAGE,
      remaining:
        remaining !== ""
          ? remaining
          : "Remaining balance: not available from this provider.",
    };
  }
  return {
    calls: totals.calls,
    totalTokens: totals.totalTokens,
    cost: formatCost(totals.costUsd),
    summary: `${formatInteger(totals.totalTokens)} tokens across ${formatInteger(totals.calls)} provider calls for this governed session.`,
    remaining:
      remaining !== ""
        ? remaining
        : "Remaining balance: not available from this provider.",
  };
}

export function buildFocusDiff(
  task: string,
  events: readonly ReefEvent[],
  verify: VerifyResult | undefined,
): string {
  const plan = extractFocusPlan(events);
  const actions = extractFocusActions(events);
  const evidenceLinks = events.length;
  const lines = [
    "--- reef-focus/task",
    "+++ reef-focus/governed-session",
    "@@",
    "- status: draft",
    `+ task: ${task}`,
    `+ plan: ${plan.join(" ")}`,
    `+ evidence-links: ${evidenceLinks}`,
  ];
  for (const [index, action] of actions.entries()) {
    const suffix =
      action.command !== undefined
        ? ` command=${action.command}`
        : action.target !== undefined
          ? ` target=${action.target}`
          : "";
    lines.push(
      `+ action[${index + 1}:${action.type}:${action.tone}]: ${action.summary}${suffix}`,
    );
  }
  lines.push(`+ verify: ${focusVerifyLabel(verify)}`);
  return lines.join("\n");
}

export function buildFocusRunView(input: {
  readonly task: string;
  readonly events: readonly ReefEvent[];
  readonly verify?: VerifyResult;
  readonly usage?: UsageSummaryResponse;
  readonly sessionId?: string;
}): FocusRunView {
  return {
    task: input.task,
    plan: extractFocusPlan(input.events),
    actions: extractFocusActions(input.events),
    evidence: input.events.map(summarizeFocusEvent),
    diff: buildFocusDiff(input.task, input.events, input.verify),
    verifyTone: focusVerifyTone(input.verify),
    verifyLabel: focusVerifyLabel(input.verify),
    usage: focusUsageSnapshot(input.usage, input.sessionId),
  };
}

function objectField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = object[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function formatCost(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toFixed(6)}`
    : "not available";
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}
