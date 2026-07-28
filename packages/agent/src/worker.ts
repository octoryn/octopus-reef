/**
 * AgentWorker — Reef's own agentic coding worker.
 *
 * This is OUR agent: the read → edit → run-tests → observe → iterate loop is
 * implemented here, not borrowed from a vendor agent framework. It only rents an
 * LLM for reasoning, through the {@link ModelProvider} seam, so the same worker
 * runs on Bedrock, a direct Anthropic/OpenAI client, a local model, or a
 * deterministic fake in tests.
 *
 * It is a Reef {@link Driver}: it proposes actions (read/edit/command) as
 * governed `DriverStep`s, and the `GovernedSession` gates, executes (confined),
 * and evidence-chains each one — then hands the real {@link ActionResult} back so
 * the worker reacts to what actually happened (a denial, a test failure, a diff).
 * The worker never touches the filesystem itself; every effect goes through the
 * session's executor and its allowlist + sandbox.
 */
import type {
  ActionRequest,
  ActionResult,
  Driver,
  DriverContext,
  DriverStep,
} from "@octopus-reef/engine";
import type {
  ContentBlock,
  ModelMessage,
  ModelProvider,
  ToolResultBlock,
  ToolSpec,
  ToolUseBlock,
} from "./provider.js";

export interface AgentWorkerOptions {
  /** The inference backend. Required — the agent is ours, the model is rented. */
  readonly provider: ModelProvider;
  /** Hard cap on model turns so a stuck agent can't burn budget. Default 16. */
  readonly maxTurns?: number;
  /** Max tokens per model turn. Default 4096. */
  readonly maxTokens?: number;
  /** Override the system prompt. */
  readonly system?: string;
  /** Truncate tool output fed back to the model (keeps context bounded). Default 4000. */
  readonly maxObservation?: number;
  /**
   * Extra, non-code tools the worker may call (an MCP tool, an HTTP API, …). They
   * are surfaced to the model alongside the built-in code tools; a call maps to a
   * governed `tool` action, so a `ToolExecutor` runs it and it becomes evidence.
   * The worker only needs the SPECS here — the executor holds the implementations.
   */
  readonly tools?: readonly ToolSpec[];
  /**
   * Resume the existing AgentWorker loop from a durable boundary. The control
   * plane persists this opaque value; it does not reproduce the agent loop.
   */
  readonly resumeFrom?: AgentWorkerCheckpoint;
  /**
   * Called at every externally durable boundary. The callback is awaited before
   * the loop advances, so a stored tool result is never followed by another
   * model turn until the checkpoint is durable.
   */
  readonly onCheckpoint?: (
    checkpoint: AgentWorkerCheckpoint,
  ) => Promise<void> | void;
}

export type AgentWorkerCheckpointPhase =
  "model_response" | "tool_intent" | "tool_result";

/** JSON-serialisable state needed to resume the existing AgentWorker loop. */
export interface AgentWorkerCheckpoint {
  readonly version: 1;
  readonly phase: AgentWorkerCheckpointPhase;
  /** Current zero-based model turn. */
  readonly turn: number;
  /** Conversation through the assistant response for the current turn. */
  readonly messages: readonly ModelMessage[];
  /** Tool calls in that response, retained until all have durable results. */
  readonly pendingToolUses: readonly ToolUseBlock[];
  /** Results already produced for pendingToolUses. */
  readonly toolResults: readonly ToolResultBlock[];
  /** First pending tool that has not produced a durable result. */
  readonly nextToolIndex: number;
  /** The tool at the current boundary, when applicable. */
  readonly tool?: ToolUseBlock;
  /** Normalized usage for a newly received model response. */
  readonly modelUsage?: CompletionResponseUsage;
}

type CompletionResponseUsage = NonNullable<
  Awaited<ReturnType<ModelProvider["complete"]>>["usage"]
>;

const DEFAULT_SYSTEM = [
  "You are a coding agent working inside a CONFINED, sandboxed workspace.",
  "Accomplish the engineering task by reading files, writing corrected files, and running the tests.",
  "Work in small steps: inspect first, make the minimal correct change, then run the tests to verify.",
  "Some actions may be DENIED by the governance layer (e.g. shell operators, non-allowlisted commands);",
  "if denied, adapt — use the read/write/run tools you are given, not shell tricks.",
  "Call `done` ONLY after a test command has actually PASSED (exit code 0). Do not narrate outside tool calls.",
].join(" ");

/** Fed back when a response is cut off at the output-token ceiling. */
const TRUNCATION_NOTICE = [
  "Your previous response was cut off at the output-token limit before it",
  "finished, so its tool call was discarded (an incomplete write_file would",
  "have truncated the file to 0 bytes). Retry with a smaller, self-contained",
  "step: prefer editing one function or a small region over rewriting a large",
  "file in a single write_file call.",
].join(" ");

const TOOLS: readonly ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file, relative to the workspace root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file (relative to the workspace root) with the FULL new content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a build/test command (e.g. 'npm test' or 'node test.js') in the workspace. Returns exit code + output.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "done",
    description: "Signal success. Call ONLY once a test command has passed.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "fail",
    description: "Signal that the task cannot be completed.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

/** Map a tool call to the governed {@link ActionRequest} it proposes, or null.
 * A name in `extra` (a registered non-code tool) becomes a generic `tool` action. */
function actionFor(
  tool: ToolUseBlock,
  extra: ReadonlySet<string>,
): ActionRequest | null {
  const input = tool.input;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (tool.name) {
    case "read_file":
      return {
        type: "read",
        summary: `read ${str(input.path)}`,
        target: str(input.path),
      };
    case "write_file":
      return {
        type: "edit",
        summary: `edit ${str(input.path)}`,
        target: str(input.path),
        payload: { content: str(input.content) },
      };
    case "run_command":
      return {
        type: "command",
        summary: `run: ${str(input.command)}`,
        payload: { command: str(input.command) },
      };
    default:
      if (extra.has(tool.name)) {
        return {
          type: "tool",
          summary: `tool: ${tool.name}`,
          payload: {
            tool: tool.name,
            input,
            // Stable across crash/resume so a remote tool can deduplicate an
            // ambiguous retry before the TOOL_RESULT checkpoint is durable.
            idempotencyKey: tool.id,
          },
        };
      }
      return null;
  }
}

/** Render an {@link ActionResult} into the text observation fed back to the model. */
function observe(
  result: ActionResult | undefined,
  cap: number,
): {
  text: string;
  isError: boolean;
} {
  if (result === undefined) return { text: "(no result)", isError: true };
  if (!result.executed) {
    return { text: `DENIED by governance: ${result.reason}`, isError: true };
  }
  const ok = result.error === undefined;
  const detail = (result.output ?? result.error ?? "").slice(0, cap);
  const exit = result.exitCode !== undefined ? `exit=${result.exitCode} ` : "";
  return {
    text: `${exit}${ok ? "ok" : "FAILED"}\n${detail}`.trim(),
    isError: !ok,
  };
}

export class AgentWorker implements Driver {
  readonly name = "octopus-agent";
  readonly #provider: ModelProvider;
  readonly #maxTurns: number;
  readonly #maxTokens: number;
  readonly #system: string;
  readonly #maxObservation: number;
  readonly #tools: readonly ToolSpec[];
  readonly #extraNames: ReadonlySet<string>;
  readonly #resumeFrom: AgentWorkerCheckpoint | undefined;
  readonly #onCheckpoint:
    ((checkpoint: AgentWorkerCheckpoint) => Promise<void> | void) | undefined;

  constructor(options: AgentWorkerOptions) {
    this.#provider = options.provider;
    this.#maxTurns = options.maxTurns ?? 16;
    this.#maxTokens = options.maxTokens ?? 4096;
    this.#system = options.system ?? DEFAULT_SYSTEM;
    this.#maxObservation = options.maxObservation ?? 4000;
    const extra = options.tools ?? [];
    this.#tools = [...TOOLS, ...extra];
    this.#extraNames = new Set(extra.map((t) => t.name));
    this.#resumeFrom = options.resumeFrom;
    this.#onCheckpoint = options.onCheckpoint;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    const resumed = this.#resumeFrom;
    const messages: ModelMessage[] = resumed
      ? cloneMessages(resumed.messages)
      : [
          {
            role: "user",
            content: `Task: ${ctx.task}\n\nBegin by reading the relevant files, then fix and verify.`,
          },
        ];
    yield {
      type: "observe",
      summary: resumed
        ? `agent resumed at turn ${resumed.turn}`
        : `agent started on "${ctx.task}"`,
    };

    let resumeBoundary = resumed;
    for (let turn = resumed?.turn ?? 0; turn < this.#maxTurns; turn++) {
      let toolUses: readonly ToolUseBlock[];
      let results: ToolResultBlock[];
      let nextToolIndex: number;
      // Set when the model hit its output-token ceiling mid-response: any
      // tool call it emitted may carry truncated/empty input, so we must NOT
      // execute it (a truncated `write_file` writes a 0-byte file).
      let truncated = false;

      if (resumeBoundary !== undefined) {
        toolUses = cloneTools(resumeBoundary.pendingToolUses);
        results = cloneToolResults(resumeBoundary.toolResults);
        nextToolIndex = resumeBoundary.nextToolIndex;
        resumeBoundary = undefined;
      } else {
        let response;
        try {
          response = await this.#provider.complete({
            system: this.#system,
            messages,
            tools: this.#tools,
            maxTokens: this.#maxTokens,
          });
        } catch (err) {
          yield {
            type: "fail",
            summary: `provider error: ${err instanceof Error ? err.message : String(err)}`,
          };
          return;
        }
        if (response.usage !== undefined) {
          const input = response.usage.inputTokens ?? 0;
          const output = response.usage.outputTokens ?? 0;
          const total = response.usage.totalTokens ?? input + output;
          yield {
            type: "observe",
            summary: `model usage: ${total} tokens (${input} input, ${output} output)`,
            data: { modelUsage: response.usage, turn },
          };
        }
        messages.push({ role: "assistant", content: response.content });

        toolUses = response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );
        truncated = response.stopReason === "max_tokens";
        results = [];
        nextToolIndex = 0;
        await this.#checkpoint({
          version: 1,
          phase: "model_response",
          turn,
          messages: cloneMessages(messages),
          pendingToolUses: cloneTools(toolUses),
          toolResults: [],
          nextToolIndex: 0,
          ...(response.usage !== undefined
            ? { modelUsage: response.usage }
            : {}),
        });

        const said = response.content
          .filter(
            (b): b is ContentBlock & { type: "text" } => b.type === "text",
          )
          .map((b) => b.text)
          .join("")
          .trim();
        if (said.length > 0) {
          yield { type: "message", text: said.slice(0, 500) };
        }
      }

      // A response cut off at the output-token ceiling cannot be trusted: the
      // final tool call's JSON input is likely incomplete, so `write_file`
      // would receive empty/partial `content` and clobber the file with 0
      // bytes. Never execute a truncated turn — bounce it back and let the
      // model retry with a smaller, complete step. Costs exactly one turn.
      if (truncated) {
        yield {
          type: "observe",
          summary:
            `model response truncated at max_tokens (turn ${turn}); ` +
            "discarded the partial tool call and asked for a smaller edit",
        };
        messages.push(
          toolUses.length > 0
            ? {
                role: "user",
                content: toolUses.map((tool) => ({
                  type: "tool_result" as const,
                  tool_use_id: tool.id,
                  content: TRUNCATION_NOTICE,
                  is_error: true,
                })),
              }
            : { role: "user", content: TRUNCATION_NOTICE },
        );
        continue;
      }

      if (toolUses.length === 0) {
        yield {
          type: "fail",
          summary: "the agent stopped without completing the task",
        };
        return;
      }

      for (let index = nextToolIndex; index < toolUses.length; index++) {
        const tool = toolUses[index]!;
        await this.#checkpoint({
          version: 1,
          phase: "tool_intent",
          turn,
          messages: cloneMessages(messages),
          pendingToolUses: cloneTools(toolUses),
          toolResults: cloneToolResults(results),
          nextToolIndex: index,
          tool: cloneTool(tool),
        });
        if (tool.name === "done") {
          yield {
            type: "done",
            summary: text(tool, "summary") || `completed "${ctx.task}"`,
          };
          return;
        }
        if (tool.name === "fail") {
          yield {
            type: "fail",
            summary: text(tool, "summary") || "the agent gave up",
          };
          return;
        }
        const action = actionFor(tool, this.#extraNames);
        if (action === null) {
          results.push({
            type: "tool_result",
            tool_use_id: tool.id,
            content: `unknown tool: ${tool.name}`,
            is_error: true,
          });
          await this.#checkpoint({
            version: 1,
            phase: "tool_result",
            turn,
            messages: cloneMessages(messages),
            pendingToolUses: cloneTools(toolUses),
            toolResults: cloneToolResults(results),
            nextToolIndex: index + 1,
            tool: cloneTool(tool),
          });
          continue;
        }
        // The session gates + executes the action and hands back the outcome.
        const result = (yield { type: "action", action }) as
          ActionResult | undefined;
        const { text: obs, isError } = observe(result, this.#maxObservation);
        results.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: obs,
          ...(isError ? { is_error: true } : {}),
        });
        await this.#checkpoint({
          version: 1,
          phase: "tool_result",
          turn,
          messages: cloneMessages(messages),
          pendingToolUses: cloneTools(toolUses),
          toolResults: cloneToolResults(results),
          nextToolIndex: index + 1,
          tool: cloneTool(tool),
        });
      }
      messages.push({ role: "user", content: results });
    }
    yield {
      type: "fail",
      summary: `stopped after ${this.#maxTurns} turns without a passing test`,
    };
  }

  async #checkpoint(checkpoint: AgentWorkerCheckpoint): Promise<void> {
    await this.#onCheckpoint?.(checkpoint);
  }
}

function text(tool: ToolUseBlock, key: string): string {
  const v = tool.input[key];
  return typeof v === "string" ? v : "";
}

function cloneMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return structuredClone(messages) as ModelMessage[];
}

function cloneTools(tools: readonly ToolUseBlock[]): ToolUseBlock[] {
  return structuredClone(tools) as ToolUseBlock[];
}

function cloneTool(tool: ToolUseBlock): ToolUseBlock {
  return structuredClone(tool) as ToolUseBlock;
}

function cloneToolResults(
  results: readonly ToolResultBlock[],
): ToolResultBlock[] {
  return structuredClone(results) as ToolResultBlock[];
}
