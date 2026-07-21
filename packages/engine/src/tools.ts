/**
 * Governed tools — the seam that lets a worker do MORE than edit code (call an
 * MCP tool, an HTTP API, any registered function) WITHOUT leaving governance.
 *
 * A `tool` action is gated (allowlist) and executed here like any other action,
 * so every external call the agent makes is a tamper-evident evidence link, not
 * an ungoverned side-channel. {@link ToolExecutor} composes a tool registry over
 * a base executor (e.g. the sandbox), so one worker can edit files AND call
 * tools, all provable.
 */
import type { JsonValue } from "octopus-evidence";
import type { ActionRequest } from "./types.js";
import type { ActionExecutor, ExecOutcome } from "./executor.js";

/**
 * A registered capability. `run` receives the tool's JSON input and returns an
 * {@link ExecOutcome} (like any executor). Keep it side-effect-honest: whatever
 * it does is recorded as evidence, so it should be the real, whole effect.
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON-schema for the tool's input (surfaced to the model by the worker). */
  readonly inputSchema: Record<string, unknown>;
  run(input: JsonValue, context?: ToolExecutionContext): Promise<ExecOutcome>;
}

export interface ToolExecutionContext {
  /** Stable model tool-use id; pass it to remote idempotency-key facilities. */
  readonly idempotencyKey?: string;
}

/** Read the `{ tool, input }` payload of a `tool` action. */
function toolCall(action: ActionRequest): {
  tool: string;
  input: JsonValue;
  idempotencyKey?: string;
} {
  const p = action.payload;
  const tool =
    p && typeof p === "object" && "tool" in p && typeof p.tool === "string"
      ? p.tool
      : "";
  const input =
    p && typeof p === "object" && "input" in p ? (p.input as JsonValue) : null;
  const idempotencyKey =
    p &&
    typeof p === "object" &&
    "idempotencyKey" in p &&
    typeof p.idempotencyKey === "string"
      ? p.idempotencyKey
      : undefined;
  return {
    tool,
    input,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

/**
 * An executor that dispatches `tool` actions to a registry and delegates every
 * other action to a base executor. Pair the base with a confined executor (the
 * sandbox) so file/command effects stay contained; the tools themselves are
 * gated by the allowlist by NAME, exactly like commands.
 */
export class ToolExecutor implements ActionExecutor {
  readonly name = "tool";
  readonly #tools: ReadonlyMap<string, Tool>;
  readonly #base: ActionExecutor | undefined;

  constructor(tools: readonly Tool[], base?: ActionExecutor) {
    this.#tools = new Map(tools.map((t) => [t.name, t]));
    this.#base = base;
  }

  /** The registered tool specs, for a worker to surface to the model. */
  specs(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async execute(action: ActionRequest): Promise<ExecOutcome> {
    if (action.type !== "tool") {
      if (this.#base === undefined) {
        return { ok: false, error: `no base executor for '${action.type}'` };
      }
      return this.#base.execute(action);
    }
    const { tool, input, idempotencyKey } = toolCall(action);
    const impl = this.#tools.get(tool);
    if (impl === undefined) {
      return { ok: false, error: `unknown tool: ${tool}` };
    }
    try {
      return await impl.run(
        input,
        idempotencyKey !== undefined ? { idempotencyKey } : {},
      );
    } catch (err) {
      return {
        ok: false,
        error: `tool ${tool} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
