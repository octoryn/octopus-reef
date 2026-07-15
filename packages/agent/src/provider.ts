/**
 * The model-provider seam — the ONE place the agent talks to an LLM.
 *
 * The agent (the {@link AgentWorker} loop) is OURS; the provider is only a
 * swappable inference backend behind this interface. A {@link BedrockProvider}
 * ships here (AWS Bedrock, via `fetch`, no SDK dependency), but the worker takes
 * any `ModelProvider` — a direct Anthropic/OpenAI client, a local model, or a
 * deterministic fake in tests — so nothing about the agent is locked to a vendor.
 */

/** A model's text output block. */
export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

/** A model's request to call a tool. */
export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

/** The caller's answer to a {@link ToolUseBlock}, fed back on the next turn. */
export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

/** One turn of the conversation. */
export interface ModelMessage {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<ContentBlock | ToolResultBlock>;
}

/** A tool the model may call — name, description, JSON-schema input. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
  readonly maxTokens: number;
}

export interface CompletionResponse {
  readonly content: readonly ContentBlock[];
  /** Why generation stopped, e.g. `"tool_use"` | `"end_turn"`. */
  readonly stopReason: string;
  /** Token usage returned by the provider API, persisted by the worker as evidence. */
  readonly usage?: ModelUsage;
}

/** The inference backend. Implement this to swap models/providers. */
export interface ModelProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/** Raised when a provider cannot produce a completion. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Normalized per-call token usage from a provider response. */
export interface ModelUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly totalTokens?: number;
}

export interface BedrockProviderOptions {
  /** Bedrock model / inference-profile id. */
  readonly model?: string;
  readonly region?: string;
  /** Bearer token; defaults to `AWS_BEARER_TOKEN_BEDROCK`. */
  readonly token?: string;
  /** Injected fetch (tests pass a fake so no network is touched). */
  readonly fetchImpl?: typeof fetch;
  /** Retries on 429/503. Default 4. */
  readonly maxRetries?: number;
  /** Base backoff ms between retries. Default 1200. */
  readonly retryBaseMs?: number;
  /** Sleep function (injectable for tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_BEDROCK_MODEL =
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";

interface RawBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * AWS Bedrock provider over the `InvokeModel` REST API (Anthropic Messages
 * shape). Uses a bearer token (`AWS_BEARER_TOKEN_BEDROCK`) and `fetch`, so it
 * needs no AWS SDK. The model id goes in the URL; the body carries
 * `anthropic_version` + messages + tools.
 */
export class BedrockProvider implements ModelProvider {
  readonly name = "bedrock";
  readonly #model: string;
  readonly #region: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #retryBaseMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: BedrockProviderOptions = {}) {
    this.#model = options.model ?? DEFAULT_BEDROCK_MODEL;
    this.#region = options.region ?? "us-west-2";
    this.#token = options.token ?? process.env.AWS_BEARER_TOKEN_BEDROCK;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxRetries = options.maxRetries ?? 4;
    this.#retryBaseMs = options.retryBaseMs ?? 1200;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.#token === undefined || this.#token === "") {
      throw new ProviderError(
        "no Bedrock bearer token (set AWS_BEARER_TOKEN_BEDROCK or pass options.token)",
      );
    }
    const url =
      `https://bedrock-runtime.${this.#region}.amazonaws.com/model/` +
      `${encodeURIComponent(this.#model)}/invoke`;
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: request.maxTokens,
      system: request.system,
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      messages: request.messages,
    });

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#token}`,
            "Content-Type": "application/json",
          },
          body,
        });
      } catch (err) {
        if (attempt >= this.#maxRetries) {
          throw new ProviderError(
            `bedrock request failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await this.#sleep(this.#retryBaseMs * (attempt + 1));
        continue;
      }
      if (
        (res.status === 429 || res.status === 503) &&
        attempt < this.#maxRetries
      ) {
        await this.#sleep(this.#retryBaseMs * (attempt + 1));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        throw new ProviderError(`bedrock ${res.status}: ${text.slice(0, 400)}`);
      }
      let parsed: {
        content?: RawBlock[];
        stop_reason?: string;
        usage?: RawUsage;
      };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new ProviderError("bedrock returned non-JSON");
      }
      return normalize(parsed, "bedrock", this.#model);
    }
  }
}

export interface AnthropicProviderOptions {
  readonly model?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Direct Anthropic Messages API provider for BYOK desktop runs. */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly #model: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #retryBaseMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: AnthropicProviderOptions = {}) {
    this.#model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.#apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxRetries = options.maxRetries ?? 4;
    this.#retryBaseMs = options.retryBaseMs ?? 1200;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.#apiKey === undefined || this.#apiKey === "") {
      throw new ProviderError(
        "no Anthropic API key (set ANTHROPIC_API_KEY or reef.model.apiKey)",
      );
    }
    const body = JSON.stringify({
      model: this.#model,
      max_tokens: request.maxTokens,
      system: request.system,
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      messages: request.messages,
    });

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": this.#apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body,
        });
      } catch (err) {
        if (attempt >= this.#maxRetries) {
          throw new ProviderError(
            `anthropic request failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await this.#sleep(this.#retryBaseMs * (attempt + 1));
        continue;
      }
      if (
        (res.status === 429 || res.status === 503) &&
        attempt < this.#maxRetries
      ) {
        await this.#sleep(this.#retryBaseMs * (attempt + 1));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        throw new ProviderError(
          `anthropic ${res.status}: ${text.slice(0, 400)}`,
        );
      }
      let parsed: {
        content?: RawBlock[];
        stop_reason?: string;
        usage?: RawUsage;
      };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new ProviderError("anthropic returned non-JSON");
      }
      return normalize(parsed, "anthropic", this.#model);
    }
  }
}

/** Coerce a raw Bedrock response into the typed {@link CompletionResponse}. */
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function normalize(
  parsed: {
    content?: RawBlock[];
    stop_reason?: string;
    usage?: RawUsage;
  },
  provider: string,
  model: string,
): CompletionResponse {
  const content: ContentBlock[] = [];
  for (const b of parsed.content ?? []) {
    if (b.type === "text" && typeof b.text === "string") {
      content.push({ type: "text", text: b.text });
    } else if (
      b.type === "tool_use" &&
      typeof b.id === "string" &&
      typeof b.name === "string"
    ) {
      content.push({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  const usage = normalizeUsage(parsed.usage, provider, model);
  return {
    content,
    stopReason: parsed.stop_reason ?? "end_turn",
    ...(usage !== undefined ? { usage } : {}),
  };
}

function normalizeUsage(
  usage: RawUsage | undefined,
  provider: string,
  model: string,
): ModelUsage | undefined {
  if (usage === undefined) return undefined;
  const inputTokens = numberOrUndefined(usage.input_tokens);
  const outputTokens = numberOrUndefined(usage.output_tokens);
  const cacheCreationInputTokens = numberOrUndefined(
    usage.cache_creation_input_tokens,
  );
  const cacheReadInputTokens = numberOrUndefined(usage.cache_read_input_tokens);
  const totalTokens =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (cacheCreationInputTokens ?? 0) +
    (cacheReadInputTokens ?? 0);
  return {
    provider,
    model,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens }
      : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    totalTokens,
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
