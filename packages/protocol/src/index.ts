/**
 * @octopus-reef/protocol — the Reef wire contract.
 *
 * One governed backend, many surfaces (CLI, IDE, Web). This package is the
 * shared, transport-agnostic vocabulary they exchange: how a session is created,
 * how its live evidence stream is framed, and how a client re-verifies it
 * store-untrusting over the wire. It re-exports the engine's own value types so a
 * client renders exactly what the engine recorded — no parallel, drifting shapes.
 *
 * The reference transport (see `@octopus-reef/server`) is plain HTTP + SSE: a
 * client POSTs to act and subscribes to a Server-Sent-Events stream to observe.
 * Nothing here assumes that, though — the same envelopes ride any transport.
 */
import type {
  ReefEvent,
  SessionOutcome,
  SessionSnapshot,
  WorkState,
} from "@octopus-reef/engine";

export type { ReefEvent, SessionOutcome, SessionSnapshot, WorkState };

/** Bumped when the wire shapes below change incompatibly. */
export const REEF_PROTOCOL_VERSION = "0.1.0";

export type ReefEdition = "community" | "commercial";

export interface EditionResponse {
  readonly edition: ReefEdition;
  readonly providers: {
    readonly byok: readonly string[];
    readonly gateway: {
      readonly available: boolean;
      readonly gated: boolean;
      readonly reason: string;
    };
  };
  readonly commercialSurfaces: {
    readonly available: boolean;
    readonly gated: boolean;
    readonly reason: string;
  };
}

/** The result of a store-untrusting verification, carried over the wire. */
export interface VerifyResult {
  /** Every check passed: the session is provable. */
  readonly ok: boolean;
  /** Work-spine integrity: `intact` | `tampered` | `<reason>`. */
  readonly work: string;
  /** Evidence-log integrity: `intact` | `tampered` | `<reason>`. */
  readonly log: string;
  /** Spine↔log cross-binding: `bound` | `unbound` | `<reason>`. */
  readonly binding: string;
}

export type ChatCommandId =
  "spec" | "plan" | "bug-fix" | "replay" | "verify" | "new-session";

export type ChatRouteWorker =
  "auto" | "codeWorker" | "toolWorker" | "cliWorker";

export type ChatCliWorker = "claude" | "codex" | "gemini";

export interface ChatCommandResolution {
  readonly id: ChatCommandId;
  readonly token: string;
  readonly label: string;
}

export interface ChatTaskReference {
  readonly specId: string;
  readonly itemId: string;
  readonly title: string;
  readonly state: WorkState;
  readonly evidenceId?: string;
}

export interface ChatRouteResolution {
  readonly token: string;
  readonly worker: ChatRouteWorker;
  readonly label: string;
  readonly cli?: ChatCliWorker;
}

/** `POST /sessions` — start a governed session. */
export interface CreateSessionRequest {
  readonly task: string;
  /** Keyed mode: the server binds every link with this HMAC (never echoed back). */
  readonly secret?: string;
  /** Persist the session to disk on the server as it seals. */
  readonly persist?: boolean;
  /** Workspace root for real governed edit/test runs. Omitted for the mock demo. */
  readonly workspaceRoot?: string;
  /** BYOK model settings. If absent or keyless, the daemon falls back to MockDriver. */
  readonly model?: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly name?: string;
    readonly licenseToken?: string;
    readonly gatewayUrl?: string;
  };
  /**
   * N5 offline MCP proof path. When present, the daemon uses an explicit
   * deterministic driver that calls the named MCP tool through the governed
   * `tool` action path. This does not require an LLM key.
   */
  readonly mcp?: {
    readonly serverId?: string;
    readonly tool?: string;
    readonly input?: unknown;
    readonly expectDenied?: boolean;
  };
  /**
   * N11 offline browser proof path. When present, the daemon uses a
   * deterministic governed session that drives a local Chrome CDP browser
   * through `tool` actions. Reads and screenshots are therefore evidence links.
   */
  readonly browser?: {
    readonly url?: string;
    readonly tool?: string;
    readonly selector?: string;
    readonly expectDenied?: boolean;
    readonly annotation?: {
      readonly url?: string;
      readonly note?: string;
      readonly bbox?: {
        readonly x?: number;
        readonly y?: number;
        readonly width?: number;
        readonly height?: number;
        readonly viewportWidth?: number;
        readonly viewportHeight?: number;
      };
    };
  };
  /**
   * N2 offline Specs proof path. When present, the daemon uses a deterministic
   * governed session that advances the named spec task through octopus-workstate
   * via a governed `tool` action. This does not require an LLM key.
   */
  readonly spec?: {
    readonly specId?: string;
    readonly itemId?: string;
    readonly to?: WorkState;
    readonly reason?: string;
  };
  /**
   * N3 steering override. If omitted, the daemon applies the globally active
   * steering set selected through `/steering`.
   */
  readonly steering?: {
    readonly ids?: readonly string[];
  };
  /** N4 hook context, recorded into the session evidence when a hook fires. */
  readonly hook?: {
    readonly id?: string;
    readonly name?: string;
    readonly trigger?: HookTrigger;
    readonly event?: Readonly<Record<string, unknown>>;
  };
  /**
   * N8 conversational surface context. Each chat turn is still its own governed
   * session, but the daemon records the conversation/approval context as
   * evidence before the driver starts working.
   */
  readonly conversation?: {
    readonly id?: string;
    readonly turn?: number;
    readonly parentSessionId?: string;
    readonly autopilot?: boolean;
    readonly approvalMode?: "auto" | "ask";
    readonly command?: ChatCommandResolution;
    readonly taskRef?: ChatTaskReference;
    readonly route?: ChatRouteResolution;
  };
  /**
   * C2/C3 account-and-plan proof path. When present, the daemon records the
   * current Reef identity, entitlement, usage, and quota snapshot as governed
   * evidence links without calling a model.
   */
  readonly account?: {
    readonly provider?: string;
    readonly model?: string;
    readonly source?: string;
    readonly gatewayUrl?: string;
    readonly ssoUrl?: string;
  };
}

/** `POST /sessions` response. */
export interface CreateSessionResponse {
  readonly id: string;
}

/** How far a session has progressed, for `GET /sessions/:id`. */
export type SessionStatus = "running" | "sealed";

/** `GET /sessions/:id` — a point-in-time view of a session. */
export interface SessionView {
  readonly id: string;
  readonly task: string;
  readonly status: SessionStatus;
  readonly outcome: SessionOutcome | null;
  /** Present once the session has sealed. */
  readonly snapshot: SessionSnapshot | null;
  /** Present once the session has sealed. */
  readonly verify: VerifyResult | null;
  /** Events emitted so far (also streamed live via the SSE endpoint). */
  readonly events: number;
}

/**
 * A frame on the `GET /sessions/:id/events` SSE stream. A subscriber always
 * receives `hello`, then every `event` in order (buffered ones replayed first,
 * so a late subscriber still sees the whole session), then a terminal `sealed`
 * carrying the final snapshot + verdict.
 */
export type ServerEvent =
  | { readonly type: "hello"; readonly id: string; readonly task: string }
  | { readonly type: "event"; readonly event: ReefEvent }
  | {
      readonly type: "sealed";
      readonly snapshot: SessionSnapshot;
      readonly verify: VerifyResult;
    };

/** An error body returned by the server (non-2xx responses). */
export interface ErrorResponse {
  readonly error: string;
}

export interface SpecVerifyResult {
  readonly ok: boolean;
  readonly work: string;
  readonly anchor?: {
    readonly length: number;
    readonly head: string;
  };
}

export interface SpecTransitionView {
  readonly itemId: string;
  readonly from: WorkState | null;
  readonly to: WorkState;
  readonly by: {
    readonly id: string;
    readonly kind: "human" | "agent" | "system";
    readonly source?: string;
    readonly displayName?: string;
  };
  readonly at: string;
  readonly evidenceId: string;
  readonly sequence: number;
  readonly reason?: string;
}

export interface SpecTaskView {
  readonly id: string;
  readonly title: string;
  readonly state: WorkState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly assignee?: {
    readonly id: string;
    readonly kind: "human" | "agent" | "system";
    readonly source?: string;
    readonly displayName?: string;
  };
  readonly history: readonly SpecTransitionView[];
}

export interface SpecView {
  readonly id: string;
  readonly title: string;
  readonly tasks: readonly SpecTaskView[];
  readonly transitions: readonly SpecTransitionView[];
  readonly anchor: {
    readonly length: number;
    readonly head: string;
  };
  readonly verify: SpecVerifyResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpecSummary {
  readonly id: string;
  readonly title: string;
  readonly taskCount: number;
  readonly states: Readonly<Record<WorkState, number>>;
  readonly anchor: {
    readonly length: number;
    readonly head: string;
  };
  readonly verify: SpecVerifyResult;
  readonly updatedAt: string;
}

/** `GET /specs` — list governed workstate specs. */
export interface SpecListResponse {
  readonly specs: readonly SpecSummary[];
}

/** `POST /specs` — create a spec and seed its workstate graph. */
export interface CreateSpecRequest {
  readonly title?: string;
  readonly tasks?: readonly string[];
}

export interface CreateSpecResponse {
  readonly spec: SpecView;
}

/** `POST /specs/:id/advance` — attempt a workstate transition. */
export interface AdvanceSpecRequest {
  readonly itemId: string;
  readonly to: WorkState;
  readonly reason?: string;
}

export interface AdvanceSpecResponse {
  readonly transition: SpecTransitionView;
  readonly spec: SpecView;
}

export interface ModelUsageView {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly totalTokens: number;
}

export interface UsageCallView extends ModelUsageView {
  readonly sessionId: string;
  readonly task: string;
  readonly evidenceId: string;
  readonly seq: number;
  readonly at: string;
  readonly costUsd?: number;
  readonly costSource?: string;
  readonly priceStatus: "priced" | "unpriced";
}

export interface UsageTotalsView {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly totalTokens: number;
  readonly costUsd?: number;
}

export interface UsageProviderTotalsView extends UsageTotalsView {
  readonly provider: string;
}

export interface UsageModelTotalsView extends UsageTotalsView {
  readonly provider: string;
  readonly model: string;
  readonly costSource?: string;
  readonly priceStatus: "priced" | "partial" | "unpriced";
}

export interface UsageSessionView {
  readonly id: string;
  readonly task: string;
  readonly totals: UsageTotalsView;
  readonly calls: readonly UsageCallView[];
}

export interface UsageRemainingView {
  readonly provider: string;
  readonly status: "available" | "pending-key" | "not-available" | "error";
  readonly source: string;
  readonly message: string;
  readonly amountUsd?: number;
  readonly limitUsd?: number;
  readonly resetAt?: string;
}

/** `GET /usage` — honest BYOK usage from persisted session evidence. */
export interface UsageSummaryResponse {
  readonly generatedAt: string;
  readonly sessions: readonly UsageSessionView[];
  readonly totals: UsageTotalsView;
  readonly byProvider: readonly UsageProviderTotalsView[];
  readonly byModel: readonly UsageModelTotalsView[];
  readonly remaining: readonly UsageRemainingView[];
}

export interface AccountIdentityView {
  readonly kind: "local-byok" | "octopus-account";
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly source: string;
}

export interface AccountUserView {
  readonly signedIn: boolean;
  readonly source: "local-byok" | "local-stub-account";
  readonly userId?: string;
  readonly displayName?: string;
  readonly licenseSha256?: string;
}

export interface AccountSsoView {
  readonly state: "signed-in" | "gated" | "community";
  readonly source: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly message: string;
}

export interface AccountTeamMemberView {
  readonly userId: string;
  readonly displayName: string;
  readonly role: "owner" | "member";
}

export interface AccountTeamView {
  readonly gated: boolean;
  readonly source: string;
  readonly message: string;
  readonly id?: string;
  readonly name?: string;
  readonly role?: "owner" | "member";
  readonly members?: readonly AccountTeamMemberView[];
}

export interface TeamAuditSessionView {
  readonly id: string;
  readonly task: string;
  readonly status: "verified" | "broken";
  readonly source: "persisted-evidence";
  readonly message: string;
}

export interface TeamAuditView {
  readonly gated: boolean;
  readonly source: string;
  readonly message: string;
  readonly sessions: readonly TeamAuditSessionView[];
}

export interface AccountEntitlementView {
  readonly allowed: boolean;
  readonly state: "community-byok" | "licensed" | "missing";
  readonly source: string;
  readonly reason: string;
  readonly licenseSha256?: string;
}

export interface AccountQuotaView {
  readonly status:
    "available" | "missing-account" | "not-available" | "pending-key" | "error";
  readonly source: string;
  readonly message: string;
  readonly planId?: string;
  readonly usedTokens?: number;
  readonly remainingTokens?: number;
  readonly limitTokens?: number;
  readonly resetAt?: string;
}

export interface AccountPlanResponse {
  readonly generatedAt: string;
  readonly edition: ReefEdition;
  readonly identity: AccountIdentityView;
  readonly account: AccountUserView;
  readonly sso: AccountSsoView;
  readonly team: AccountTeamView;
  readonly audit: TeamAuditView;
  readonly entitlement: AccountEntitlementView;
  readonly usage: UsageSummaryResponse;
  readonly plan: {
    readonly name: string;
    readonly upgradeAvailable: boolean;
    readonly quota: AccountQuotaView;
  };
  /** The governed session created by a local stub-SSO sign-in, when applicable. */
  readonly evidenceSessionId?: string;
}

export interface AccountLoginRequest {
  readonly userId?: string;
  readonly displayName?: string;
  readonly licenseToken?: string;
  /** Optional loopback issuer for the local OIDC discovery/token stub. */
  readonly ssoUrl?: string;
}

export type SteeringItemKind = "doc" | "skill";

export interface SteeringItemView {
  readonly id: string;
  readonly title: string;
  readonly kind: SteeringItemKind;
  readonly content: string;
  readonly contentSha256: string;
  readonly source: "built-in" | "custom";
  readonly mockEffect?: string;
  readonly updatedAt: string;
}

export interface SteeringListResponse {
  readonly available: readonly SteeringItemView[];
  readonly activeIds: readonly string[];
  readonly active: readonly SteeringItemView[];
}

export interface SetSteeringActiveRequest {
  readonly activeIds?: readonly string[];
}

export interface AddCustomSteeringRequest {
  readonly title?: string;
  readonly kind?: SteeringItemKind;
  readonly content?: string;
  readonly mockEffect?: string;
}

export type HookTrigger = "on-demand" | "on-save";

export interface HookDefinitionView {
  readonly id: string;
  readonly name: string;
  readonly trigger: HookTrigger;
  readonly task: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HookListResponse {
  readonly hooks: readonly HookDefinitionView[];
}

export interface CreateHookRequest {
  readonly name?: string;
  readonly trigger?: HookTrigger;
  readonly task?: string;
  readonly enabled?: boolean;
}

export interface FireHookRequest {
  readonly event?: Readonly<Record<string, unknown>>;
  readonly persist?: boolean;
}

export interface FireHookResponse {
  readonly hook: HookDefinitionView;
  readonly sessionId: string;
}
