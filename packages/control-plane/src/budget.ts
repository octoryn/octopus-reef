import type { BudgetController } from "./ports.js";
import type {
  AgentRun,
  BudgetDecision,
  RunBudget,
  RunUsage,
  UsageDelta,
} from "./types.js";

const ZERO_USAGE: RunUsage = {
  tokens: 0,
  costUsd: 0,
  wallTimeMs: 0,
  toolCalls: 0,
  outputBytes: 0,
};

export function emptyUsage(): RunUsage {
  return { ...ZERO_USAGE };
}

export function addUsage(
  usage: RunUsage,
  delta: UsageDelta,
  wallTimeMs: number,
): RunUsage {
  return {
    tokens: usage.tokens + nonNegative(delta.tokens),
    costUsd: usage.costUsd + nonNegative(delta.costUsd),
    wallTimeMs: Math.max(usage.wallTimeMs, wallTimeMs),
    toolCalls: usage.toolCalls + nonNegative(delta.toolCalls),
    outputBytes: usage.outputBytes + nonNegative(delta.outputBytes),
  };
}

/** Deterministic enforcement for tokens, cost, wall time, tools and output. */
export class DefaultBudgetController implements BudgetController {
  evaluate(run: AgentRun, delta: UsageDelta, now: string): BudgetDecision {
    const started = Date.parse(run.startedAt ?? run.createdAt);
    const current = Date.parse(now);
    const wallTimeMs = Math.max(0, current - started);
    const usage = addUsage(run.usage, delta, wallTimeMs);
    const checks: readonly [keyof RunBudget, number, number | undefined][] = [
      ["maxTokens", usage.tokens, run.budget.maxTokens],
      ["maxCostUsd", usage.costUsd, run.budget.maxCostUsd],
      ["maxWallTimeMs", usage.wallTimeMs, run.budget.maxWallTimeMs],
      ["maxToolCalls", usage.toolCalls, run.budget.maxToolCalls],
      ["maxOutputBytes", usage.outputBytes, run.budget.maxOutputBytes],
    ];
    for (const [name, actual, limit] of checks) {
      if (limit !== undefined && actual > limit) {
        return {
          allowed: false,
          usage,
          exceeded: name,
          reason: `${name} exceeded: ${actual} > ${limit}`,
        };
      }
    }
    return { allowed: true, usage };
  }
}

function nonNegative(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `usage delta must be a finite non-negative number: ${value}`,
    );
  }
  return value;
}
