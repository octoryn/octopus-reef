import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { ReefEvent } from "@octopus-reef/engine";
import type {
  ModelUsageView,
  UsageCallView,
  UsageModelTotalsView,
  UsageProviderTotalsView,
  UsageRemainingView,
  UsageSessionView,
  UsageSummaryResponse,
  UsageTotalsView,
} from "@octopus-reef/protocol";

interface UsageSourceSession {
  readonly id: string;
  readonly task: string;
  readonly events: readonly ReefEvent[];
}

interface PersistedUsageEvent {
  readonly seq: number;
  readonly at: string;
  readonly evidenceId: string;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
}

interface PriceEntry {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
  readonly cacheCreationInputPerMillionUsd?: number;
  readonly cacheReadInputPerMillionUsd?: number;
  readonly source: string;
}

interface UsageSummaryOptions {
  readonly now?: () => string;
  readonly persistDir?: string;
  readonly sessions?: readonly UsageSourceSession[];
}

const ZERO_TOTALS: UsageTotalsView = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
};

const PRICE_TABLE: Readonly<Record<string, PriceEntry>> = {
  "anthropic:claude-test": {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 3,
    source: "N6 injected-provider test price table",
  },
};

export function usageSummary(
  options: UsageSummaryOptions,
): UsageSummaryResponse {
  const sessions = collectSessions(options);
  const usageSessions = sessions
    .map((session) => usageForSession(session))
    .filter((session) => session.calls.length > 0);
  const calls = usageSessions.flatMap((session) => session.calls);
  return {
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    sessions: usageSessions,
    totals: totalCalls(calls),
    byProvider: providerTotals(calls),
    byModel: modelTotals(calls),
    remaining: remainingStatuses(),
  };
}

function collectSessions(
  options: UsageSummaryOptions,
): readonly UsageSourceSession[] {
  const byId = new Map<string, UsageSourceSession>();
  for (const session of options.sessions ?? []) byId.set(session.id, session);
  if (options.persistDir !== undefined) {
    for (const session of readPersistedSessions(options.persistDir)) {
      if (!byId.has(session.id)) byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function readPersistedSessions(root: string): UsageSourceSession[] {
  if (!existsSync(root)) return [];
  const sessions: UsageSourceSession[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const logPath = join(dir, "session.log.jsonl");
    if (!existsSync(logPath) || !statSync(logPath).isFile()) continue;
    const events = readPersistedUsageEvents(logPath);
    sessions.push({
      id: entry.name,
      task: readPersistedTask(dir) ?? entry.name,
      events: events.map(persistedToReefEvent),
    });
  }
  return sessions;
}

function readPersistedTask(dir: string): string | undefined {
  const metaPath = join(dir, "session.json");
  if (!existsSync(metaPath)) return undefined;
  const parsed = safeParse(readFileSync(metaPath, "utf8"));
  const task = object(parsed).task;
  return typeof task === "string" && task.trim() !== "" ? task : undefined;
}

function readPersistedUsageEvents(logPath: string): PersistedUsageEvent[] {
  const body = readFileSync(logPath, "utf8");
  const lines = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  const events: PersistedUsageEvent[] = [];
  let seq = 0;
  for (const raw of lines.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const record = object(safeParse(line));
    const evidence = object(record.evidence);
    const content = object(evidence.content);
    const provenance = object(evidence.provenance);
    events.push({
      seq,
      at:
        typeof provenance.at === "string"
          ? provenance.at
          : new Date(0).toISOString(),
      evidenceId: typeof evidence.id === "string" ? evidence.id : "",
      summary:
        typeof content.summary === "string" ? content.summary : "evidence",
      data: content,
    });
    seq++;
  }
  return events;
}

function persistedToReefEvent(event: PersistedUsageEvent): ReefEvent {
  const kind =
    typeof event.data.kind === "string" ? event.data.kind : "observation";
  return {
    seq: event.seq,
    kind: kind as ReefEvent["kind"],
    at: event.at,
    evidenceId: event.evidenceId,
    summary: event.summary,
    data: event.data,
  };
}

function usageForSession(session: UsageSourceSession): UsageSessionView {
  const calls = session.events.flatMap((event) => {
    const usage = normalizeUsage(event.data.modelUsage);
    if (usage === undefined) return [];
    const cost = costForUsage(usage);
    const call: UsageCallView = {
      sessionId: session.id,
      task: session.task,
      evidenceId: event.evidenceId,
      seq: event.seq,
      at: event.at,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      totalTokens: usage.totalTokens,
      priceStatus: cost === undefined ? "unpriced" : "priced",
      ...(cost !== undefined
        ? { costUsd: cost.costUsd, costSource: cost.source }
        : {}),
    };
    return [call];
  });
  return {
    id: session.id,
    task: session.task,
    totals: totalCalls(calls),
    calls,
  };
}

function normalizeUsage(value: unknown): ModelUsageView | undefined {
  const usage = object(value);
  const provider = stringValue(usage.provider);
  const model = stringValue(usage.model);
  if (provider === undefined || model === undefined) return undefined;
  const inputTokens = numberValue(usage.inputTokens) ?? 0;
  const outputTokens = numberValue(usage.outputTokens) ?? 0;
  const cacheCreationInputTokens =
    numberValue(usage.cacheCreationInputTokens) ?? 0;
  const cacheReadInputTokens = numberValue(usage.cacheReadInputTokens) ?? 0;
  const totalTokens =
    numberValue(usage.totalTokens) ??
    inputTokens +
      outputTokens +
      cacheCreationInputTokens +
      cacheReadInputTokens;
  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens,
  };
}

function costForUsage(
  usage: ModelUsageView,
): { readonly costUsd: number; readonly source: string } | undefined {
  const price = PRICE_TABLE[`${usage.provider}:${usage.model}`];
  if (price === undefined) return undefined;
  const costUsd =
    (usage.inputTokens * price.inputPerMillionUsd +
      usage.outputTokens * price.outputPerMillionUsd +
      usage.cacheCreationInputTokens *
        (price.cacheCreationInputPerMillionUsd ??
          price.inputPerMillionUsd) +
      usage.cacheReadInputTokens *
        (price.cacheReadInputPerMillionUsd ?? price.inputPerMillionUsd)) /
    1_000_000;
  return { costUsd, source: price.source };
}

function totalCalls(calls: readonly UsageCallView[]): UsageTotalsView {
  let totals = ZERO_TOTALS;
  let costUsd = 0;
  let priced = false;
  for (const call of calls) {
    totals = addUsage(totals, call);
    if (call.costUsd !== undefined) {
      priced = true;
      costUsd += call.costUsd;
    }
  }
  return {
    ...totals,
    ...(priced ? { costUsd } : {}),
  };
}

function providerTotals(
  calls: readonly UsageCallView[],
): UsageProviderTotalsView[] {
  const map = new Map<string, UsageCallView[]>();
  for (const call of calls) {
    const group = map.get(call.provider) ?? [];
    group.push(call);
    map.set(call.provider, group);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, group]) => ({ provider, ...totalCalls(group) }));
}

function modelTotals(calls: readonly UsageCallView[]): UsageModelTotalsView[] {
  const map = new Map<string, UsageCallView[]>();
  for (const call of calls) {
    const key = `${call.provider}\u0000${call.model}`;
    const group = map.get(key) ?? [];
    group.push(call);
    map.set(key, group);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const [provider = "", model = ""] = key.split("\u0000");
      const priced = group.filter((call) => call.costUsd !== undefined);
      const costSource = priced[0]?.costSource;
      return {
        provider,
        model,
        ...totalCalls(group),
        priceStatus:
          priced.length === 0
            ? "unpriced"
            : priced.length === group.length
              ? "priced"
              : "partial",
        ...(costSource !== undefined ? { costSource } : {}),
      };
    });
}

function addUsage(
  totals: UsageTotalsView,
  usage: ModelUsageView,
): UsageTotalsView {
  return {
    calls: totals.calls + 1,
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheCreationInputTokens:
      totals.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    cacheReadInputTokens:
      totals.cacheReadInputTokens + usage.cacheReadInputTokens,
    totalTokens: totals.totalTokens + usage.totalTokens,
  };
}

function remainingStatuses(): UsageRemainingView[] {
  return [
    {
      provider: "anthropic",
      status: "pending-key",
      source: "Anthropic billing/admin API",
      message: "Live remaining balance/limit lookup is pending a BYOK/admin key.",
    },
    {
      provider: "bedrock",
      status: "not-available",
      source: "AWS Bedrock/AWS Billing",
      message:
        "AWS Bedrock does not expose a normalized remaining token or credit value to Reef; use AWS Billing/Budgets for limits.",
    },
  ];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
