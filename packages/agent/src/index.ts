/**
 * @octopus-reef/agent — Reef's own agentic coding worker.
 *
 * The agent loop is ours; the model is rented through a provider seam, so the
 * worker is not locked to any vendor. Wire an {@link AgentWorker} into a
 * `GovernedSession` and every step it takes is gated, confined, and
 * evidence-chained — a worker that does real work AND is independently provable.
 */
export { AgentWorker } from "./worker.js";
export type { AgentWorkerOptions } from "./worker.js";
export {
  BedrockProvider,
  ProviderError,
  DEFAULT_BEDROCK_MODEL,
} from "./provider.js";
export type {
  ModelProvider,
  CompletionRequest,
  CompletionResponse,
  ModelMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolSpec,
  BedrockProviderOptions,
} from "./provider.js";
