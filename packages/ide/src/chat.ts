import type {
  ChatCommandResolution,
  ChatRouteResolution,
  ChatTaskReference,
  VerifyResult,
} from "@octopus-reef/protocol";

export interface ChatModelSettings {
  readonly provider?: string;
  readonly apiKey?: string;
  readonly name?: string;
  readonly gatewayUrl?: string;
}

export interface ChatModelEnvironment {
  readonly REEF_MODEL_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly AWS_BEARER_TOKEN_BEDROCK?: string;
  readonly REEF_GATEWAY_URL?: string;
}

export interface ChatModelChip {
  readonly label: string;
  readonly provider: "mock" | "anthropic" | "bedrock" | "gateway";
  readonly keyed: boolean;
}

export interface ChatConversationInput {
  readonly conversationId: string;
  readonly turn: number;
  readonly parentSessionId?: string;
  readonly autopilot: boolean;
  readonly command?: ChatCommandResolution;
  readonly taskRef?: ChatTaskReference;
  readonly route?: ChatRouteResolution;
}

export interface ChatConversationContext {
  readonly id: string;
  readonly turn: number;
  readonly autopilot: boolean;
  readonly approvalMode: "auto" | "ask";
  readonly parentSessionId?: string;
  readonly command?: ChatCommandResolution;
  readonly taskRef?: ChatTaskReference;
  readonly route?: ChatRouteResolution;
}

export type ChatVerifyTone = "ok" | "bad" | "pending";

export function chatModelChip(
  settings: ChatModelSettings | undefined,
  env: ChatModelEnvironment = process.env,
): ChatModelChip {
  const requested = (settings?.provider ?? "auto").trim().toLowerCase();
  const explicitKey = trim(settings?.apiKey);
  const reefKey = trim(env.REEF_MODEL_API_KEY);
  const anthropicKey = explicitKey ?? reefKey ?? trim(env.ANTHROPIC_API_KEY);
  const bedrockKey =
    explicitKey ?? reefKey ?? trim(env.AWS_BEARER_TOKEN_BEDROCK);
  const modelName = trim(settings?.name);
  const gatewayUrl = trim(settings?.gatewayUrl) ?? trim(env.REEF_GATEWAY_URL);

  // A configured hosted gateway wins for "auto" too: commercial sessions
  // auto-provision a gateway token server-side, so this is the real provider.
  if (
    requested === "gateway" ||
    (requested === "auto" && gatewayUrl !== undefined)
  ) {
    return {
      label: `Gateway · ${modelName ?? "Hosted Claude"}`,
      provider: "gateway",
      keyed: true,
    };
  }
  if (requested === "bedrock") {
    return bedrockKey === undefined
      ? mockChip()
      : {
          label: `Bedrock · ${modelName ?? "Claude Sonnet 4.5"}`,
          provider: "bedrock",
          keyed: true,
        };
  }
  if (requested === "anthropic" || requested === "claude") {
    return anthropicKey === undefined
      ? mockChip()
      : {
          label: `Anthropic · ${modelName ?? "Claude"}`,
          provider: "anthropic",
          keyed: true,
        };
  }
  if (trim(env.AWS_BEARER_TOKEN_BEDROCK) !== undefined) {
    return {
      label: `Bedrock · ${modelName ?? "Claude Sonnet 4.5"}`,
      provider: "bedrock",
      keyed: true,
    };
  }
  if (trim(env.ANTHROPIC_API_KEY) !== undefined || explicitKey !== undefined) {
    return {
      label: `Anthropic · ${modelName ?? "Claude"}`,
      provider: "anthropic",
      keyed: true,
    };
  }
  return mockChip();
}

export function chatConversationContext(
  input: ChatConversationInput,
): ChatConversationContext {
  const base = {
    id: input.conversationId.trim() || "reef-chat",
    turn: Number.isInteger(input.turn) && input.turn > 0 ? input.turn : 1,
    autopilot: input.autopilot,
    approvalMode: input.autopilot ? ("auto" as const) : ("ask" as const),
  };
  return input.parentSessionId !== undefined &&
    input.parentSessionId.trim() !== ""
    ? appendAffordances(
        { ...base, parentSessionId: input.parentSessionId.trim() },
        input,
      )
    : appendAffordances(base, input);
}

export function chatApprovalLabel(autopilot: boolean): string {
  return autopilot
    ? "Autopilot auto-approved"
    : "Approval requested and granted";
}

export function chatVerifyTone(
  verify: VerifyResult | undefined,
): ChatVerifyTone {
  if (verify === undefined) return "pending";
  return verify.ok ? "ok" : "bad";
}

function mockChip(): ChatModelChip {
  return { label: "Mock · Offline", provider: "mock", keyed: false };
}

function appendAffordances(
  base: Omit<ChatConversationContext, "command" | "taskRef" | "route">,
  input: ChatConversationInput,
): ChatConversationContext {
  return {
    ...base,
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.taskRef !== undefined ? { taskRef: input.taskRef } : {}),
    ...(input.route !== undefined ? { route: input.route } : {}),
  };
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  return cleaned === "" ? undefined : cleaned;
}
