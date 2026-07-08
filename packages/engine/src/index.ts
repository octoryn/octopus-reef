/**
 * @octopus-reef/engine — the governed session engine.
 *
 * Reef makes agentic engineering *provable*: every session is a tamper-evident,
 * cross-bound, independently-verifiable, replayable evidence chain over a
 * governed work spine. This package is the shared brain behind every Reef
 * surface (CLI, IDE, Web) — the surfaces are thin; the governance lives here.
 */
export { GovernedSession } from "./session.js";
export type { SessionOptions, SessionResult } from "./session.js";

export { EvidenceLog } from "./log.js";
export type { EvidenceLogOptions, LogRecord, VerifyLogOptions } from "./log.js";

export { DefaultGate } from "./gate.js";
export type { ActionGate } from "./gate.js";

export {
  reefAllowlist,
  allowAll,
  requireAll,
  LOCAL_PRINCIPAL,
} from "./authz.js";
export type { Authorizer, Principal, ReefAllowlistOptions } from "./authz.js";

export { NoopExecutor, WorkspaceExecutor, canonicalRoot } from "./executor.js";
export type { ActionExecutor, ExecOutcome } from "./executor.js";

export { ToolExecutor } from "./tools.js";
export type { Tool } from "./tools.js";

export {
  SandboxExecutor,
  defaultRunner,
  darwinSandboxRunner,
  subprocessRunner,
} from "./sandbox.js";
export type {
  CommandRunner,
  CommandResult,
  SandboxOptions,
} from "./sandbox.js";

export { MockDriver, UnsafeDemoDriver } from "./driver.js";

export { persistSession, loadSession } from "./persist.js";
export type { PersistOptions, LoadedSession } from "./persist.js";

export { replaySession, reconstructEvents } from "./replay.js";
export type { ReplayedSession } from "./replay.js";

export { verifyBinding } from "./verify.js";
export type { BindingResult } from "./verify.js";

export { assertJson, assertJsonObject, EngineError } from "./json.js";

export type {
  Actor,
  WorkState,
  ActionType,
  ActionRequest,
  ActionResult,
  GateVerdict,
  SessionOutcome,
  ReefEventKind,
  ReefEvent,
  DriverStep,
  DriverContext,
  Driver,
  SessionSnapshot,
} from "./types.js";
