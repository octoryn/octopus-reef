import {
  AgentWorker,
  recordOf,
  type AgentWorkerCheckpoint,
  type AgentWorkerOptions,
  type ModelUsage,
  type ModelProvider,
  type ToolResultBlock,
} from "@octopus-reef/agent";
import {
  GovernedSession,
  NoopExecutor,
  allowAll,
  type ActionExecutor,
  type Authorizer,
  type ReefEvent,
} from "@octopus-reef/engine";
import type {
  AgentKernel,
  AgentRun,
  KernelCheckpoint,
  KernelContext,
  KernelResult,
  SandboxHandle,
} from "./types.js";

export interface ReefAgentKernelOptions {
  readonly provider: (context: {
    readonly run: AgentRun;
    readonly secrets: Readonly<Record<string, string>>;
  }) => ModelProvider | Promise<ModelProvider>;
  readonly executor?: (context: {
    readonly run: AgentRun;
    readonly sandbox: SandboxHandle;
    readonly secrets: Readonly<Record<string, string>>;
  }) => ActionExecutor | Promise<ActionExecutor>;
  readonly authorizer?: Authorizer;
  readonly worker?: Omit<
    AgentWorkerOptions,
    "provider" | "resumeFrom" | "onCheckpoint"
  >;
  readonly now?: () => string;
  /** Deployment pricing table/function; core remains provider-neutral. */
  readonly costUsd?: (usage: ModelUsage) => number;
}

/**
 * Thin durable adapter over the existing AgentWorker and GovernedSession. It
 * deliberately contains no planning/tool loop of its own.
 */
export class ReefAgentKernel implements AgentKernel {
  readonly #options: ReefAgentKernelOptions;

  constructor(options: ReefAgentKernelOptions) {
    this.#options = options;
  }

  async run(context: KernelContext): Promise<KernelResult> {
    const verifiedResume = completedFromKernelVerification(context.resumeFrom);
    if (verifiedResume !== undefined) return verifiedResume;
    const provider = await this.#options.provider({
      run: context.run,
      secrets: context.secrets,
    });
    const executor =
      (await this.#options.executor?.({
        run: context.run,
        sandbox: context.sandbox,
        secrets: context.secrets,
      })) ?? new NoopExecutor();
    const resumeFrom = agentCheckpoint(context.resumeFrom?.payload);
    let checkpointError: unknown;
    const driver = new AgentWorker({
      provider,
      ...this.#options.worker,
      ...(resumeFrom !== undefined ? { resumeFrom } : {}),
      onCheckpoint: async (checkpoint): Promise<void> => {
        try {
          await context.checkpoint(
            toKernelCheckpoint(checkpoint, this.#options.costUsd),
          );
        } catch (error) {
          checkpointError = error;
          throw error;
        }
      },
    });
    const session = new GovernedSession({
      id: `${context.run.id}-attempt-${context.run.attempt}`,
      task: context.run.task,
      driver,
      executor,
      authorizer: this.#options.authorizer ?? allowAll,
      signal: context.signal,
      ...(this.#options.now !== undefined ? { now: this.#options.now } : {}),
    });
    const result = await session.run();
    if (checkpointError !== undefined) throw checkpointError;
    const proof = {
      record: recordOf(session),
      verification: session.verify(),
      snapshot: result.snapshot,
    };
    const reason = sealedReason(result.events);
    await context.checkpoint({
      kind: "VERIFICATION",
      idempotencyKey: `kernel-verification:${context.run.attempt}`,
      payload: { ...proof, output: reason },
    });
    if (result.outcome === "completed" && session.verify().ok) {
      return { outcome: "COMPLETED", output: reason, proof };
    }
    return {
      outcome: "FAILED",
      failure: {
        code: result.outcome === "cancelled" ? "CANCELLED" : "AGENT_FAILED",
        message: reason || `agent session ${result.outcome}`,
        retryable: result.outcome !== "cancelled",
      },
      proof,
    };
  }
}

function toKernelCheckpoint(
  checkpoint: AgentWorkerCheckpoint,
  costUsd?: (usage: ModelUsage) => number,
): KernelCheckpoint {
  const toolId = checkpoint.tool?.id;
  if (checkpoint.phase === "model_response") {
    const usage = checkpoint.modelUsage;
    return {
      kind: "MODEL_RESPONSE",
      idempotencyKey: `model-response:${checkpoint.turn}`,
      payload: { agent: checkpoint },
      ...(usage !== undefined
        ? {
            usage: {
              tokens:
                usage.totalTokens ??
                (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
              ...(costUsd !== undefined ? { costUsd: costUsd(usage) } : {}),
            },
          }
        : {}),
    };
  }
  if (checkpoint.phase === "tool_intent") {
    return {
      kind: "TOOL_INTENT",
      idempotencyKey: `tool-intent:${toolId ?? checkpoint.nextToolIndex}`,
      payload: { agent: checkpoint },
      ...(checkpoint.tool !== undefined
        ? {
            step: {
              id: checkpoint.tool.id,
              kind: checkpoint.tool.name,
              input: checkpoint.tool.input,
            },
          }
        : {}),
    };
  }
  const result = resultFor(checkpoint, toolId);
  return {
    kind: "TOOL_RESULT",
    idempotencyKey: `tool-result:${toolId ?? checkpoint.nextToolIndex - 1}`,
    payload: { agent: checkpoint },
    usage: {
      toolCalls: 1,
      outputBytes: Buffer.byteLength(result?.content ?? "", "utf8"),
    },
    ...(checkpoint.tool !== undefined
      ? {
          step: {
            id: checkpoint.tool.id,
            kind: checkpoint.tool.name,
            ...(result !== undefined ? { output: result } : {}),
          },
        }
      : {}),
  };
}

function resultFor(
  checkpoint: AgentWorkerCheckpoint,
  toolId: string | undefined,
): ToolResultBlock | undefined {
  return checkpoint.toolResults.find((result) => result.tool_use_id === toolId);
}

function agentCheckpoint(value: unknown): AgentWorkerCheckpoint | undefined {
  if (value === null || typeof value !== "object" || !("agent" in value)) {
    return undefined;
  }
  const candidate = (value as { agent?: unknown }).agent;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    (candidate as { version?: unknown }).version !== 1
  ) {
    return undefined;
  }
  return candidate as AgentWorkerCheckpoint;
}

function sealedReason(events: readonly ReefEvent[]): string {
  const value = [...events]
    .reverse()
    .find((event) => event.kind === "session.sealed")?.data["reason"];
  return typeof value === "string" ? value : "";
}

function completedFromKernelVerification(
  checkpoint: KernelContext["resumeFrom"],
): KernelResult | undefined {
  if (checkpoint?.kind !== "VERIFICATION") return undefined;
  const value = checkpoint.payload;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const verification = record["verification"];
  const snapshot = record["snapshot"];
  if (
    verification === null ||
    typeof verification !== "object" ||
    (verification as Record<string, unknown>)["ok"] !== true ||
    snapshot === null ||
    typeof snapshot !== "object" ||
    (snapshot as Record<string, unknown>)["outcome"] !== "completed"
  ) {
    return undefined;
  }
  return {
    outcome: "COMPLETED",
    output:
      typeof record["output"] === "string" ? record["output"] : "completed",
    proof: value,
  };
}
