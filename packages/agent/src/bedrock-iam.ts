import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  DEFAULT_BEDROCK_MODEL,
  ProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type ModelProvider,
  type ModelUsage,
} from "./provider.js";

export interface BedrockIamProviderOptions {
  /** Bedrock model or inference-profile id. */
  readonly model?: string;
  readonly region?: string;
}

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
 * Same-account Bedrock provider using the AWS SDK default credential chain.
 * On Fargate that resolves the task role and signs InvokeModel with SigV4; no
 * bearer token, API key, or AgentRun secretRef is involved.
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
    if (this.#client === undefined || this.#invoke === undefined) {
      // The SDK otherwise prefers the Bedrock bearer-token path over SigV4.
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      const sdk = await import("@aws-sdk/client-bedrock-runtime");
      this.#client = new sdk.BedrockRuntimeClient({ region: this.#region });
      this.#invoke = sdk.InvokeModelCommand;
    }
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: request.maxTokens,
      system: request.system,
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      messages: request.messages,
    });

    let raw: Uint8Array | undefined;
    try {
      const output = await this.#client.send(
        new this.#invoke({
          modelId: this.#model,
          contentType: "application/json",
          accept: "application/json",
          body,
        }),
      );
      raw = output.body;
    } catch (error) {
      throw new ProviderError(
        `bedrock (iam) request failed: ${error instanceof Error ? error.message : String(error)}`,
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
    return mapBedrockIamResponse(parsed, this.#model);
  }
}

export function mapBedrockIamResponse(
  parsed: { content?: RawBlock[]; stop_reason?: string; usage?: RawUsage },
  model: string,
): CompletionResponse {
  const content: ContentBlock[] = [];
  for (const block of parsed.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      });
    }
  }
  let usage: ModelUsage | undefined;
  if (parsed.usage !== undefined) {
    const inputTokens = number(parsed.usage.input_tokens);
    const outputTokens = number(parsed.usage.output_tokens);
    const cacheCreationInputTokens = number(
      parsed.usage.cache_creation_input_tokens,
    );
    const cacheReadInputTokens = number(parsed.usage.cache_read_input_tokens);
    usage = {
      provider: "bedrock-iam",
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

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
