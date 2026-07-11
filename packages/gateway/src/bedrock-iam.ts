import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  ModelProvider,
  ModelUsage,
} from "@octopus-reef/agent";
import { ProviderError } from "@octopus-reef/agent";

export interface BedrockIamProviderOptions {
  /** Bedrock model / inference-profile id. */
  readonly model?: string;
  readonly region?: string;
}

const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

interface RawBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Bedrock provider using **same-account IAM (SigV4)** auth via the AWS SDK's
 * default credential chain — on Fargate this resolves the task role, so no bearer
 * token / API key is needed at all. Isolated to the gateway package (the AWS SDK
 * dependency lives here, not in the shared, bundled `@octopus-reef/agent`). The
 * request/response shape matches `BedrockProvider` (Anthropic-on-Bedrock).
 */
export class BedrockIamProvider implements ModelProvider {
  readonly name = "bedrock-iam";
  readonly #model: string;
  readonly #region: string;
  #client: BedrockRuntimeClient | undefined;
  #invoke:
    | (typeof import("@aws-sdk/client-bedrock-runtime"))["InvokeModelCommand"]
    | undefined;

  constructor(options: BedrockIamProviderOptions = {}) {
    this.#model = options.model ?? DEFAULT_BEDROCK_MODEL;
    this.#region = options.region ?? "us-west-2";
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Lazy-load the SDK so it is only pulled in when the IAM path actually runs.
    if (this.#client === undefined || this.#invoke === undefined) {
      // The AWS SDK treats AWS_BEARER_TOKEN_BEDROCK as a Bedrock API key and switches
      // to bearer-token auth, which OVERRIDES SigV4. In IAM mode we must sign with the
      // task role, so a stray/blank bearer token cannot be present — clear it.
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      const sdk = await import("@aws-sdk/client-bedrock-runtime");
      this.#client = new sdk.BedrockRuntimeClient({ region: this.#region });
      this.#invoke = sdk.InvokeModelCommand;
    }
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

    let raw: Uint8Array | undefined;
    try {
      const out = await this.#client.send(
        new this.#invoke({
          modelId: this.#model,
          contentType: "application/json",
          accept: "application/json",
          body,
        }),
      );
      raw = out.body;
    } catch (err) {
      // Surface the real SDK error to the logs; the completion service otherwise
      // collapses it to a generic "model provider failed".
      console.error("[bedrock-iam] invoke failed:", err);
      throw new ProviderError(
        `bedrock (iam) request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (raw === undefined) throw new ProviderError("bedrock (iam) empty body");

    let parsed: {
      content?: RawBlock[];
      stop_reason?: string;
      usage?: RawUsage;
    };
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw)) as typeof parsed;
    } catch {
      throw new ProviderError("bedrock (iam) returned non-JSON");
    }
    return mapResponse(parsed, this.#model);
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function mapResponse(
  parsed: { content?: RawBlock[]; stop_reason?: string; usage?: RawUsage },
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
  let usage: ModelUsage | undefined;
  if (parsed.usage !== undefined) {
    const inputTokens = num(parsed.usage.input_tokens);
    const outputTokens = num(parsed.usage.output_tokens);
    const cacheCreationInputTokens = num(
      parsed.usage.cache_creation_input_tokens,
    );
    const cacheReadInputTokens = num(parsed.usage.cache_read_input_tokens);
    usage = {
      provider: "bedrock",
      model,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens }
        : {}),
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    };
  }
  return {
    content,
    stopReason: parsed.stop_reason ?? "end_turn",
    ...(usage !== undefined ? { usage } : {}),
  };
}
