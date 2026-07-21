/**
 * @octopus-reef/agent — Reef's own agentic coding worker.
 *
 * The agent loop is ours; the model is rented through a provider seam, so the
 * worker is not locked to any vendor. Wire an {@link AgentWorker} into a
 * `GovernedSession` and every step it takes is gated, confined, and
 * evidence-chained — a worker that does real work AND is independently provable.
 */
export { AgentWorker } from "./worker.js";
export type {
  AgentWorkerCheckpoint,
  AgentWorkerCheckpointPhase,
  AgentWorkerOptions,
} from "./worker.js";
export {
  AnthropicProvider,
  BedrockProvider,
  DEFAULT_ANTHROPIC_MODEL,
  ProviderError,
  DEFAULT_BEDROCK_MODEL,
} from "./provider.js";
export { BedrockIamProvider, mapBedrockIamResponse } from "./bedrock-iam.js";
export type { BedrockIamProviderOptions } from "./bedrock-iam.js";

// The conductor: govern + route + prove a fleet of heterogeneous workers.
export {
  Orchestrator,
  LlmPlanner,
  LlmRouter,
  verifyLedger,
  ledgerHead,
} from "./orchestrator.js";
export type {
  Worker,
  WorkerResult,
  Subtask,
  Planner,
  Router,
  OrchestrationStep,
  OrchestrationResult,
  OrchestratorOptions,
  WorkerLedger,
  Acceptance,
  AcceptanceSeam,
  SessionRecord,
} from "./orchestrator.js";
export { codeWorker, toolWorker } from "./workers.js";
export type { CodeWorkerOptions, ToolWorkerOptions } from "./workers.js";

// Wrap an external agent CLI (Claude Code / Codex / …) as a governed worker.
export { cliWorker, runCliWithDiff } from "./cli.js";
export type { CliWorkerOptions, CliRunResult, FileChange } from "./cli.js";
export { recordOf } from "./session-result.js";
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
  AnthropicProviderOptions,
  BedrockProviderOptions,
  ModelUsage,
} from "./provider.js";
