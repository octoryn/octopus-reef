/**
 * ClaudeDriver — the real agent behind a Reef session (M1a: governed planning).
 *
 * It asks `claude-opus-4-8` to turn a task into a structured plan of governed
 * steps (observations, proposed actions, messages), which the GovernedSession
 * gates and evidence-chains exactly like the mock. Every proposed command still
 * passes through the session's ActionGate before it is recorded.
 *
 * ⚠️ M1a does NOT execute real commands. Real execution (bash/edit) requires the
 * allowlist + OS sandbox seam (M1b) — after the 2026-07-06 incident, wiring real
 * shell execution before that sandbox exists is deliberately out of scope. This
 * driver plans under governance; it does not act on the machine.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  Driver,
  DriverContext,
  DriverStep,
  ActionType,
} from "@octopus-reef/engine";

export const DEFAULT_MODEL = "claude-opus-4-8";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The minimal client surface we use — lets tests inject a fake with no network. */
export interface ClaudeMessagesClient {
  messages: {
    create(
      body: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

export interface ClaudeDriverOptions {
  /** Inject a client (real or fake). Defaults to a real Anthropic SDK client. */
  readonly client?: ClaudeMessagesClient;
  readonly apiKey?: string;
  readonly model?: string;
  readonly effort?: Effort;
}

interface PlanStep {
  readonly kind: "observe" | "message" | "action";
  readonly summary: string;
  readonly actionType?: ActionType;
  readonly target?: string;
  readonly command?: string;
  readonly required?: boolean;
}
interface Plan {
  readonly summary: string;
  readonly steps: readonly PlanStep[];
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["observe", "message", "action"] },
          summary: { type: "string" },
          actionType: {
            type: "string",
            enum: ["read", "search", "edit", "command", "pr", "message"],
          },
          target: { type: "string" },
          command: { type: "string" },
          required: { type: "boolean" },
        },
        required: ["kind", "summary"],
      },
    },
  },
  required: ["summary", "steps"],
} as const;

const SYSTEM = [
  "You are the planning brain of Reef, a governed agentic engineering workspace.",
  "Turn the user's engineering task into a concise, ordered plan of governed steps.",
  "Each step is an observation (what you inspected), a message (a note to the user),",
  "or an action you PROPOSE to take. Actions are gated before they run — dangerous",
  "commands will be denied — so propose the safe, minimal command that does the job.",
  "Prefer specific, real commands and file targets. Do not narrate; return the plan.",
].join(" ");

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

export class ClaudeDriver implements Driver {
  readonly name = "claude";
  readonly #client: ClaudeMessagesClient;
  readonly #model: string;
  readonly #effort: Effort;

  constructor(options: ClaudeDriverOptions = {}) {
    this.#client =
      options.client ??
      (new Anthropic(
        options.apiKey !== undefined ? { apiKey: options.apiKey } : {},
      ) as unknown as ClaudeMessagesClient);
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#effort = options.effort ?? "high";
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    const response = await this.#client.messages.create({
      model: this.#model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: this.#effort,
        format: { type: "json_schema", schema: PLAN_SCHEMA },
      },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Task: ${ctx.task}\n\nReturn a governed plan for this task.`,
        },
      ],
    });

    let plan: Plan;
    try {
      plan = JSON.parse(textOf(response.content)) as Plan;
    } catch (err) {
      yield {
        type: "fail",
        summary: `could not parse a plan from the model: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    for (const step of plan.steps ?? []) {
      if (step.kind === "observe") {
        yield { type: "observe", summary: step.summary };
      } else if (step.kind === "message") {
        yield { type: "message", text: step.summary };
      } else {
        const type: ActionType = step.actionType ?? "command";
        yield {
          type: "action",
          action: {
            type,
            summary: step.summary,
            ...(step.target !== undefined ? { target: step.target } : {}),
            ...(step.command !== undefined
              ? { payload: { command: step.command } }
              : {}),
            ...(step.required === true ? { required: true } : {}),
          },
        };
      }
    }

    yield { type: "done", summary: plan.summary || `planned "${ctx.task}"` };
  }
}
