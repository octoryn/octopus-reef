import {
  BedrockProvider,
  type CompletionRequest,
  type CompletionResponse,
  type ModelProvider,
} from "@octopus-reef/agent";
import { BedrockIamProvider } from "./bedrock-iam.js";
import type { GatewayConfig } from "./types.js";

export function createGatewayModelProvider(config: GatewayConfig): ModelProvider {
  const model = config.bedrockModel !== undefined ? { model: config.bedrockModel } : {};
  // Same-account IAM (SigV4) path: no key — the AWS SDK resolves the task role.
  if ((process.env.REEF_GATEWAY_BEDROCK_AUTH ?? "").trim().toLowerCase() === "iam") {
    return new BedrockIamProvider({ ...model, region: config.awsRegion });
  }
  // Bearer-token path: a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK.
  if ((process.env.AWS_BEARER_TOKEN_BEDROCK ?? "").trim() !== "") {
    return new BedrockProvider({ ...model, region: config.awsRegion });
  }
  return new LocalDeterministicProvider();
}

export class LocalDeterministicProvider implements ModelProvider {
  readonly name = "reef-gateway-local";

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const text = summarizeRequest(request);
    const inputTokens = estimateTokens(JSON.stringify(request.messages));
    const outputTokens = estimateTokens(text);
    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
      stopReason: "end_turn",
      usage: {
        provider: this.name,
        model: "reef-gateway-local-deterministic",
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }
}

function summarizeRequest(request: CompletionRequest): string {
  const last = request.messages.at(-1);
  const raw =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? "");
  return `reef gateway local completion: ${raw.slice(0, 120)}`;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
