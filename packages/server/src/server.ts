/**
 * ReefServer — one governed-session backend, over plain HTTP + SSE.
 *
 * The surfaces (CLI, IDE, Web) are thin; the governance lives in the engine, and
 * this daemon simply hosts it and streams what it records. A client:
 *   POST /sessions            → start a governed session, get its id
 *   GET  /sessions/:id        → a point-in-time view (snapshot + verdict)
 *   GET  /sessions/:id/events → the live evidence stream (Server-Sent Events)
 *   GET  /sessions/:id/verify → re-verify store-untrusting, over the wire
 *   GET  /health              → liveness
 *
 * The event stream replays every buffered event before live-tailing, so a client
 * that connects late still observes the whole session in order — which is what
 * lets two independent clients watch one live session and both verify it.
 *
 * SSE (not WebSocket) is deliberate: it needs no dependency, works in browsers
 * (`EventSource`), Node, and editors alike, and a governed tool minimises its
 * supply chain. Clients act via POST and observe via the stream.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import {
  GovernedSession,
  MockDriver,
  SandboxExecutor,
  ToolExecutor,
  loadSession,
  persistSession,
  reefAllowlist,
  type ActionExecutor,
  type ActionResult,
  type Authorizer,
  type Driver,
  type DriverContext,
  type DriverStep,
  type ReefEvent,
  type SessionOutcome,
  type SessionSnapshot,
  type Tool,
} from "@octopus-reef/engine";
import {
  AgentWorker,
  AnthropicProvider,
  BedrockProvider,
  Orchestrator,
  ledgerHead,
  recordOf,
  verifyLedger,
  type ModelProvider,
  type Planner,
  type Router,
  type Subtask,
  type Worker,
  type WorkerLedger,
  type WorkerResult,
} from "@octopus-reef/agent";
import {
  GatewayProvider,
  gatewayEntitlementDecision,
  priorityModelTier,
  gatewayQuotaDecision,
  gatewayRouteDecision,
  type GatewayEntitlementDecision,
  type GatewayQuotaDecision,
  type GatewayRouteDecision,
  type PriorityModelTier,
} from "@octopus-reef/commercial";
import type { JsonValue } from "octopus-evidence";
import type {
  AccountLoginRequest,
  AccountPlanResponse,
  AddCustomSteeringRequest,
  ChatCommandResolution,
  ChatRouteResolution,
  ChatTaskReference,
  CreateManagerFleetRequest,
  CreateHookRequest,
  CreateSessionRequest,
  EditionResponse,
  FireHookRequest,
  ManagerFleetLedgerView,
  ManagerFleetVerifyResponse,
  ManagerFleetView,
  ManagerSessionCardView,
  ReefEdition,
  SetSteeringActiveRequest,
  ServerEvent,
  SessionView,
  SteeringItemView,
  TeamAuditSessionView,
  VerifyResult,
} from "@octopus-reef/protocol";
import {
  AccountPlanDriver,
  AccountStore,
  accountGovernanceContext,
  accountPlan,
  type AccountSnapshotRequest,
} from "./account.js";
import {
  McpPowerRegistry,
  type AddCustomPowerRequest,
} from "./mcp.js";
import { BrowserDemoDriver, BrowserPowerRuntime } from "./browser.js";
import { HookRegistry } from "./hooks.js";
import {
  SpecRegistry,
  type AdvanceSpecRequest,
  type CreateSpecRequest,
} from "./specs.js";
import { SteeringRegistry } from "./steering.js";
import { usageSummary } from "./usage.js";

interface SessionRecord {
  readonly id: string;
  readonly task: string;
  session: GovernedSession;
  readonly events: ReefEvent[];
  readonly subscribers: Set<ServerResponse>;
  readonly sealed: Promise<void>;
  readonly finish: () => void;
  status: "running" | "sealed";
  snapshot: SessionSnapshot | null;
  verify: VerifyResult | null;
  outcome: SessionOutcome | null;
  cleanup?: () => void;
}

interface ManagerFleetRecord {
  readonly id: string;
  readonly createdAt: string;
  sessionIds: readonly string[];
  status: "running" | "sealed";
  updatedAt: string;
  ledger: WorkerLedger | null;
  ledgerHead: string | null;
  ledgerVerified: boolean | null;
}

interface McpSessionRequest {
  readonly serverId?: string;
  readonly tool?: string;
  readonly input?: unknown;
  readonly expectDenied?: boolean;
}

interface BrowserSessionRequest {
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
}

interface SpecSessionRequest {
  readonly specId?: string;
  readonly itemId?: string;
  readonly to?: string;
  readonly reason?: string;
}

interface SteeringSessionRequest {
  readonly ids?: readonly string[];
}

interface HookSessionRequest {
  readonly id?: string;
  readonly name?: string;
  readonly trigger?: string;
  readonly event?: Readonly<Record<string, unknown>>;
}

interface ConversationSessionRequest {
  readonly id?: string;
  readonly turn?: number;
  readonly parentSessionId?: string;
  readonly autopilot?: boolean;
  readonly approvalMode?: "auto" | "ask";
  readonly command?: ChatCommandResolution;
  readonly taskRef?: ChatTaskReference;
  readonly route?: ChatRouteResolution;
}

interface AccountSessionRequest {
  readonly provider?: string;
  readonly model?: string;
  readonly source?: string;
  readonly gatewayUrl?: string;
  readonly ssoUrl?: string;
  readonly priorityTier?: PriorityModelTier;
}

class McpDemoDriver implements Driver {
  readonly name = "mcp-demo";
  readonly #tool: string;
  readonly #input: unknown;
  readonly #expectDenied: boolean;

  constructor(options: {
    readonly tool: string;
    readonly input: unknown;
    readonly expectDenied?: boolean;
  }) {
    this.#tool = options.tool;
    this.#input = options.input;
    this.#expectDenied = options.expectDenied === true;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    yield {
      type: "observe",
      summary: `resolved MCP power for "${ctx.task}"`,
      data: { tool: this.#tool, expectDenied: this.#expectDenied },
    };
    const result = (yield {
      type: "action",
      action: {
        type: "tool",
        summary: `MCP tool call: ${this.#tool}`,
        target: this.#tool,
        payload: { tool: this.#tool, input: this.#input },
        required: !this.#expectDenied,
      },
    }) as ActionResult | undefined;

    if (this.#expectDenied) {
      if (result?.allowed === false && result.executed === false) {
        yield {
          type: "done",
          summary: `denied unallowlisted MCP tool ${this.#tool}`,
        };
        return;
      }
      yield {
        type: "fail",
        summary: `expected MCP tool ${this.#tool} to be denied`,
      };
      return;
    }

    if (result?.executed === true && result.error === undefined) {
      yield {
        type: "observe",
        summary: `MCP tool ${this.#tool} returned`,
        data: {
          tool: this.#tool,
          outputBytes: result.output?.length ?? 0,
        },
      };
      yield { type: "done", summary: `called MCP tool ${this.#tool}` };
      return;
    }

    yield {
      type: "fail",
      summary: `MCP tool ${this.#tool} did not execute: ${result?.error ?? result?.reason ?? "no result"}`,
    };
  }
}

class SpecAdvanceDriver implements Driver {
  readonly name = "spec-demo";
  readonly #specId: string;
  readonly #itemId: string;
  readonly #to: string;
  readonly #input: Readonly<Record<string, unknown>>;

  constructor(options: {
    readonly specId: string;
    readonly itemId: string;
    readonly to: string;
    readonly input: Readonly<Record<string, unknown>>;
  }) {
    this.#specId = options.specId;
    this.#itemId = options.itemId;
    this.#to = options.to;
    this.#input = options.input;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    yield {
      type: "observe",
      summary: `resolved spec workstate transition for "${ctx.task}"`,
      data: { specId: this.#specId, itemId: this.#itemId, to: this.#to },
    };
    const result = (yield {
      type: "action",
      action: {
        type: "tool",
        summary: `Spec transition: ${this.#itemId} -> ${this.#to}`,
        target: "reef-spec.advance",
        payload: { tool: "reef-spec.advance", input: this.#input },
        required: true,
      },
    }) as ActionResult | undefined;

    if (result?.executed === true && result.error === undefined) {
      const recorded = parseSpecAdvanceOutput(result.output);
      yield {
        type: "observe",
        summary: `Spec transition recorded: ${this.#itemId} -> ${this.#to}`,
        data: {
          specId: this.#specId,
          itemId: this.#itemId,
          to: this.#to,
          ...(recorded.transitionEvidenceId !== undefined
            ? { transitionEvidenceId: recorded.transitionEvidenceId }
            : {}),
          ...(recorded.sequence !== undefined
            ? { sequence: recorded.sequence }
            : {}),
        },
      };
      yield {
        type: "done",
        summary: `advanced spec ${this.#specId} task ${this.#itemId} to ${this.#to}`,
      };
      return;
    }

    yield {
      type: "fail",
      summary: `spec transition failed: ${result?.error ?? result?.reason ?? "no result"}`,
    };
  }
}

class SteeringDriver implements Driver {
  readonly name: string;
  readonly #inner: Driver;
  readonly #items: readonly SteeringItemView[];

  constructor(inner: Driver, items: readonly SteeringItemView[]) {
    this.#inner = inner;
    this.#items = items;
    this.name = `${inner.name}+steering`;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    const active = this.#items.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      source: item.source,
      contentSha256: item.contentSha256,
    }));
    yield {
      type: "observe",
      summary: `applied steering set: ${active.map((item) => item.id).join(", ")}`,
      data: { steeringSet: { active } },
    };
    for (const item of this.#items) {
      if (item.mockEffect !== undefined) {
        yield { type: "message", text: item.mockEffect };
      }
    }
    yield* this.#inner.run(ctx);
  }
}

class HookDriver implements Driver {
  readonly name: string;
  readonly #inner: Driver;
  readonly #hook: Required<
    Pick<HookSessionRequest, "id" | "name" | "trigger">
  > &
    Pick<HookSessionRequest, "event">;

  constructor(inner: Driver, hook: HookSessionRequest) {
    this.#inner = inner;
    this.#hook = {
      id: optionalString(hook.id) ?? "hook",
      name: optionalString(hook.name) ?? "Reef hook",
      trigger: optionalString(hook.trigger) ?? "on-demand",
      event: hook.event ?? {},
    };
    this.name = `${inner.name}+hook`;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    yield {
      type: "observe",
      summary: `hook fired: ${this.#hook.name}`,
      data: {
        hook: {
          id: this.#hook.id,
          name: this.#hook.name,
          trigger: this.#hook.trigger,
          event: this.#hook.event ?? {},
          task: ctx.task,
        },
      },
    };
    yield* this.#inner.run(ctx);
  }
}

class ConversationDriver implements Driver {
  readonly name: string;
  readonly #inner: Driver;
  readonly #conversation: {
    readonly id: string;
    readonly turn: number;
    readonly parentSessionId: string | null;
    readonly autopilot: boolean;
    readonly approvalMode: "auto" | "ask";
    readonly command?: ChatCommandResolution;
    readonly taskRef?: ChatTaskReference;
    readonly route?: ChatRouteResolution;
  };

  constructor(inner: Driver, request: ConversationSessionRequest) {
    this.#inner = inner;
    const autopilot = request.autopilot === true;
    this.#conversation = {
      id: optionalString(request.id) ?? "reef-chat",
      turn:
        typeof request.turn === "number" &&
        Number.isInteger(request.turn) &&
        request.turn > 0
          ? request.turn
          : 1,
      parentSessionId: optionalString(request.parentSessionId) ?? null,
      autopilot,
      approvalMode:
        request.approvalMode === "ask" && !autopilot ? "ask" : "auto",
      ...(request.command !== undefined ? { command: request.command } : {}),
      ...(request.taskRef !== undefined ? { taskRef: request.taskRef } : {}),
      ...(request.route !== undefined ? { route: request.route } : {}),
    };
    this.name = `${inner.name}+conversation`;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    if (this.#conversation.route !== undefined) {
      yield {
        type: "observe",
        summary: `chat route resolved: ${this.#conversation.route.token} -> ${this.#conversation.route.worker}`,
        data: {
          chatRoute: {
            ...this.#conversation.route,
            conversationId: this.#conversation.id,
            turn: this.#conversation.turn,
          },
        },
      };
    }
    if (this.#conversation.taskRef !== undefined) {
      yield {
        type: "observe",
        summary: `chat task pinned: ${this.#conversation.taskRef.itemId}`,
        data: {
          chatTaskRef: {
            ...this.#conversation.taskRef,
            conversationId: this.#conversation.id,
            turn: this.#conversation.turn,
          },
        },
      };
    }
    if (this.#conversation.command !== undefined) {
      yield {
        type: "observe",
        summary: `chat command resolved: ${this.#conversation.command.token}`,
        data: {
          chatCommand: {
            ...this.#conversation.command,
            conversationId: this.#conversation.id,
            turn: this.#conversation.turn,
          },
        },
      };
    }
    const decision =
      this.#conversation.approvalMode === "auto"
        ? "autopilot auto-approved the turn"
        : "human approval was requested and granted";
    yield {
      type: "observe",
      summary: `chat turn ${this.#conversation.turn} approved: ${decision}`,
      data: {
        conversation: {
          id: this.#conversation.id,
          turn: this.#conversation.turn,
          parentSessionId: this.#conversation.parentSessionId,
          autopilot: this.#conversation.autopilot,
          approvalMode: this.#conversation.approvalMode,
          approvalDecision: {
            approved: true,
            source:
              this.#conversation.approvalMode === "auto"
                ? "autopilot"
                : "human",
            policy: "reef-chat-approval",
          },
          task: ctx.task,
        },
      },
    };
    yield* this.#inner.run(ctx);
  }
}

/** Adds the commercial team context to every signed-in governed run. */
class TeamEvidenceDriver implements Driver {
  readonly name: string;
  readonly #inner: Driver;
  readonly #context: Pick<AccountPlanResponse, "sso" | "team" | "entitlement">;

  constructor(
    inner: Driver,
    context: Pick<AccountPlanResponse, "sso" | "team" | "entitlement">,
  ) {
    this.#inner = inner;
    this.#context = context;
    this.name = `${inner.name}+team`;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    yield {
      type: "observe",
      summary: `OIDC SSO entitlement: ${this.#context.entitlement.allowed ? "allowed" : "denied"}`,
      data: {
        teamSso: {
          sso: this.#context.sso,
          entitlement: this.#context.entitlement,
          task: ctx.task,
        },
      },
    };
    yield {
      type: "observe",
      summary: `team membership recorded: ${this.#context.team.name ?? "unknown team"}`,
      data: { teamMembership: this.#context.team },
    };
    yield* this.#inner.run(ctx);
  }
}

class GatewayGovernanceDriver implements Driver {
  readonly name: string;
  readonly #inner: Driver | undefined;
  readonly #entitlement: GatewayEntitlementDecision;
  readonly #quota: GatewayQuotaDecision;
  readonly #route: GatewayRouteDecision | undefined;
  readonly #failure: string | undefined;

  constructor(options: {
    readonly inner?: Driver;
    readonly entitlement: GatewayEntitlementDecision;
    readonly quota: GatewayQuotaDecision;
    readonly route?: GatewayRouteDecision;
    readonly failure?: string;
  }) {
    this.#inner = options.inner;
    this.#entitlement = options.entitlement;
    this.#quota = options.quota;
    this.#route = options.route;
    this.#failure = options.failure;
    this.name =
      options.inner === undefined
        ? "gateway-governance"
        : `${options.inner.name}+gateway`;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    yield {
      type: "observe",
      summary: `gateway entitlement decision: ${this.#entitlement.allowed ? "allowed" : "denied"}`,
      data: { entitlementDecision: this.#entitlement },
    };
    yield {
      type: "observe",
      summary: `gateway quota decision: ${this.#quota.allowed ? "allowed" : "denied"}`,
      data: { quotaDecision: this.#quota },
    };
    if (this.#failure !== undefined) {
      yield { type: "fail", summary: this.#failure };
      return;
    }
    if (this.#route !== undefined) {
      yield {
        type: "observe",
        summary: `priority model tier selected: ${this.#route.priority.tier}`,
        data: { priorityTierDecision: this.#route.priority, task: ctx.task },
      };
      yield {
        type: "observe",
        summary: `gateway route selected: ${this.#route.route}`,
        data: { gatewayRoute: this.#route, task: ctx.task },
      };
    }
    if (this.#inner === undefined) {
      yield { type: "fail", summary: "gateway provider was not configured" };
      return;
    }
    yield* this.#inner.run(ctx);
  }
}

export interface DriverFactoryContext {
  readonly task: string;
  readonly workspaceRoot?: string;
  readonly model?: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly name?: string;
    readonly licenseToken?: string;
    readonly accessToken?: string;
    readonly gatewayUrl?: string;
    readonly priorityTier?: PriorityModelTier;
  };
  readonly edition: ReefEdition;
}

export interface SessionRuntime {
  readonly driver: Driver;
  readonly authorizer?: Authorizer;
  readonly executor?: ActionExecutor;
  readonly cleanup?: () => void;
}

export interface ReefServerOptions {
  /** Persist each session to `<dir>/<id>` as it seals. */
  readonly persistDir?: string;
  /**
   * Build the driver for a session. Defaults to the offline {@link MockDriver},
   * so the server runs keyless out of the box (Docker demo, tests). A deployment
   * swaps in a real agent driver here.
   */
  readonly driverFactory?: (
    context: DriverFactoryContext,
  ) => Driver | SessionRuntime;
  /**
   * Serve a built single-page app (the web surface) for non-API GET routes, so
   * one container hosts both the governed backend and the UI. Unknown paths fall
   * back to `index.html` (client-side routing).
   */
  readonly staticDir?: string;
  /** Max resident sessions before the oldest sealed one is evicted. Default 500. */
  readonly maxSessions?: number;
  /** Max concurrent SSE subscribers per session. Default 64. */
  readonly maxSubscribers?: number;
  /** Build flavor served by this daemon. Default follows REEF_EDITION, then community. */
  readonly edition?: ReefEdition;
}

const MAX_BODY = 64 * 1024;
const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_MAX_SUBSCRIBERS = 64;
const DEFAULT_REAL_COMMANDS: Readonly<Record<string, readonly string[] | "*">> =
  {
    node: "*",
    npm: ["test", "run"],
    git: ["status", "diff", "log", "show", "rev-parse", "ls-files"],
  };
const CHAT_COMMAND_IDS = new Set([
  "spec",
  "plan",
  "bug-fix",
  "replay",
  "verify",
  "new-session",
]);
const CHAT_ROUTES = new Map<
  string,
  {
    readonly worker: ChatRouteResolution["worker"];
    readonly cli?: ChatRouteResolution["cli"];
  }
>([
  ["auto", { worker: "auto" }],
  ["@code", { worker: "codeWorker" }],
  ["@tool", { worker: "toolWorker" }],
  ["@cli:claude", { worker: "cliWorker", cli: "claude" }],
  ["@cli:codex", { worker: "cliWorker", cli: "codex" }],
  ["@cli:gemini", { worker: "cliWorker", cli: "gemini" }],
]);

class ConfigurationFailureDriver implements Driver {
  readonly name = "configuration";
  readonly #message: string;

  constructor(message: string) {
    this.#message = message;
  }

  async *run(): AsyncIterable<DriverStep> {
    yield { type: "fail", summary: this.#message };
  }
}

class RequestFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseSpecAdvanceOutput(output: string | undefined): {
  readonly transitionEvidenceId?: string;
  readonly sequence?: number;
} {
  if (output === undefined) return {};
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return {
      ...(typeof parsed.transitionEvidenceId === "string"
        ? { transitionEvidenceId: parsed.transitionEvidenceId }
        : {}),
      ...(typeof parsed.sequence === "number"
        ? { sequence: parsed.sequence }
        : {}),
    };
  } catch {
    return {};
  }
}

function sessionContext(
  task: string,
  body: CreateSessionRequest,
  edition: ReefEdition,
): DriverFactoryContext {
  const modelBody =
    body.model !== null && typeof body.model === "object"
      ? (body.model as Record<string, unknown>)
      : undefined;
  const model: NonNullable<DriverFactoryContext["model"]> = {
    ...maybe("provider", optionalString(modelBody?.provider)),
    ...maybe("apiKey", optionalString(modelBody?.apiKey)),
    ...maybe("name", optionalString(modelBody?.name)),
    ...maybe("licenseToken", optionalString(modelBody?.licenseToken)),
    ...maybe("accessToken", optionalString(modelBody?.accessToken)),
    ...maybe("gatewayUrl", optionalString(modelBody?.gatewayUrl)),
    ...(optionalString(modelBody?.priorityTier) !== undefined
      ? {
          priorityTier: priorityModelTier(
            optionalString(modelBody?.priorityTier),
          ),
        }
      : {}),
  };
  return {
    task,
    edition,
    ...maybe("workspaceRoot", optionalString(body.workspaceRoot)),
    ...(Object.keys(model).length > 0 ? { model } : {}),
  };
}

function accountQuery(url: URL): AccountSnapshotRequest {
  return {
    ...maybe("provider", optionalString(url.searchParams.get("provider"))),
    ...maybe("model", optionalString(url.searchParams.get("model"))),
    ...maybe("source", optionalString(url.searchParams.get("source"))),
    ...maybe("gatewayUrl", optionalString(url.searchParams.get("gatewayUrl"))),
    ...maybe("ssoUrl", optionalString(url.searchParams.get("ssoUrl"))),
    ...(optionalString(url.searchParams.get("priorityTier")) !== undefined
      ? {
          priorityTier: priorityModelTier(
            optionalString(url.searchParams.get("priorityTier")),
          ),
        }
      : {}),
  };
}

function maybe<T>(
  key: string,
  value: T | undefined,
): Record<string, T> | Record<string, never> {
  return value === undefined ? {} : { [key]: value };
}

function teamAuditSessions(
  persistDir: string | undefined,
  teamId: string,
): readonly TeamAuditSessionView[] {
  if (persistDir === undefined || !existsSync(persistDir)) return [];
  const marker = `"teamMembership":{"gated":false`;
  const teamMarker = `"id":"${teamId}"`;
  const rows: TeamAuditSessionView[] = [];
  for (const entry of readdirSync(persistDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("sess-")) continue;
    const dir = join(persistDir, entry.name);
    const logPath = join(dir, "session.log.jsonl");
    const snapshotPath = join(dir, "session.json");
    if (!existsSync(logPath) || !existsSync(snapshotPath)) continue;
    let raw: string;
    let task = entry.name;
    try {
      raw = readFileSync(logPath, "utf8");
      if (!raw.includes(marker) || !raw.includes(teamMarker)) continue;
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
        task?: unknown;
      };
      if (typeof snapshot.task === "string" && snapshot.task.trim() !== "") {
        task = snapshot.task;
      }
    } catch {
      continue;
    }
    try {
      loadSession(dir);
      rows.push({
        id: entry.name,
        task,
        status: "verified",
        source: "persisted-evidence",
        message:
          "Work spine, evidence log, and their cross-binding verify intact.",
      });
    } catch (err) {
      rows.push({
        id: entry.name,
        task,
        status: "broken",
        source: "persisted-evidence",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows.sort((left, right) => right.id.localeCompare(left.id));
}

function normalizeRuntime(value: Driver | SessionRuntime): SessionRuntime {
  return "driver" in value ? value : { driver: value };
}

function defaultRuntime(context: DriverFactoryContext): SessionRuntime {
  const requested = (
    context.model?.provider ??
    process.env.REEF_MODEL_PROVIDER ??
    "auto"
  ).toLowerCase();
  if (requested === "gateway") {
    return gatewayRuntime(context);
  }
  // Commercial "auto": if the user is signed into a hosted gateway (a gateway URL
  // AND an auth token are configured), route through it. BYOK/offline users without
  // a gateway token fall through to the key/mock logic below, unchanged.
  if (requested === "auto") {
    const gwUrl =
      context.model?.gatewayUrl ?? optionalString(process.env.REEF_GATEWAY_URL);
    const gwToken =
      context.model?.accessToken ??
      context.model?.licenseToken ??
      optionalString(process.env.REEF_GATEWAY_ACCESS_TOKEN) ??
      optionalString(process.env.REEF_LICENSE_TOKEN) ??
      optionalString(process.env.REEF_ENTITLEMENT_TOKEN);
    if (gwUrl !== undefined && gwToken !== undefined) {
      return gatewayRuntime(context);
    }
  }
  const providerName = selectProvider(requested, context.model?.apiKey);
  if (providerName === "mock") return { driver: new MockDriver() };

  const workspaceRoot =
    context.workspaceRoot ?? optionalString(process.env.REEF_WORKSPACE_ROOT);
  if (workspaceRoot === undefined) {
    return {
      driver: new ConfigurationFailureDriver(
        "real model provider configured but no workspace root was provided",
      ),
    };
  }

  const provider = createProvider(providerName, context.model);
  if (provider === undefined) return { driver: new MockDriver() };

  const executor = new SandboxExecutor(workspaceRoot, { timeoutMs: 25_000 });
  return {
    driver: new AgentWorker({ provider, maxTurns: 30 }),
    authorizer: reefAllowlist({ commands: DEFAULT_REAL_COMMANDS }),
    executor,
    cleanup: () => executor.dispose(),
  };
}

function gatewayRuntime(context: DriverFactoryContext): SessionRuntime {
  if (context.edition !== "commercial") {
    return {
      driver: new ConfigurationFailureDriver(
        "gateway provider is not available in the community edition",
      ),
    };
  }

  const licenseToken =
    context.model?.licenseToken ??
    optionalString(process.env.REEF_LICENSE_TOKEN) ??
    optionalString(process.env.REEF_ENTITLEMENT_TOKEN);
  const accessToken =
    context.model?.accessToken ??
    optionalString(process.env.REEF_GATEWAY_ACCESS_TOKEN);
  const authToken = accessToken ?? licenseToken;
  const entitlement = gatewayEntitlementDecision(
    authToken === undefined ? {} : { licenseToken: authToken },
  );
  const quota = gatewayQuotaDecision({
    entitlementAllowed: entitlement.allowed,
  });
  if (!entitlement.allowed || authToken === undefined) {
    return {
      driver: new GatewayGovernanceDriver({
        entitlement,
        quota,
        failure: "gateway provider denied: entitlement missing",
      }),
    };
  }
  if (!quota.allowed) {
    return {
      driver: new GatewayGovernanceDriver({
        entitlement,
        quota,
        failure: `gateway provider denied: ${quota.reason}`,
      }),
    };
  }

  const gatewayUrl =
    context.model?.gatewayUrl ?? optionalString(process.env.REEF_GATEWAY_URL);
  if (gatewayUrl === undefined) {
    return {
      driver: new GatewayGovernanceDriver({
        entitlement,
        quota,
        failure: "gateway provider denied: REEF_GATEWAY_URL is not configured",
      }),
    };
  }

  const priorityTier = priorityModelTier(context.model?.priorityTier);

  const route = gatewayRouteDecision({
    gatewayUrl,
    licenseToken: authToken,
    priorityTier,
    ...(context.model?.name !== undefined ? { model: context.model.name } : {}),
  });
  const provider = new GatewayProvider({
    gatewayUrl,
    ...(licenseToken !== undefined ? { licenseToken } : {}),
    ...(accessToken !== undefined ? { accessToken } : {}),
    priorityTier,
    ...(context.model?.name !== undefined ? { model: context.model.name } : {}),
  });
  return {
    driver: new GatewayGovernanceDriver({
      inner: new AgentWorker({ provider, maxTurns: 2 }),
      entitlement,
      quota,
      route,
    }),
  };
}

function selectProvider(requested: string, explicitKey: string | undefined) {
  if (requested === "mock") return "mock";
  if (requested === "anthropic" || requested === "claude") {
    return apiKeyFor("anthropic", explicitKey) === undefined
      ? "mock"
      : "anthropic";
  }
  if (requested === "bedrock") {
    return apiKeyFor("bedrock", explicitKey) === undefined ? "mock" : "bedrock";
  }
  if (apiKeyFor("anthropic", explicitKey) !== undefined) return "anthropic";
  if (apiKeyFor("bedrock", explicitKey) !== undefined) return "bedrock";
  return "mock";
}

function apiKeyFor(
  provider: "anthropic" | "bedrock",
  explicitKey: string | undefined,
): string | undefined {
  return (
    explicitKey ??
    optionalString(process.env.REEF_MODEL_API_KEY) ??
    (provider === "anthropic"
      ? optionalString(process.env.ANTHROPIC_API_KEY)
      : optionalString(process.env.AWS_BEARER_TOKEN_BEDROCK))
  );
}

function createProvider(
  provider: "anthropic" | "bedrock",
  model: DriverFactoryContext["model"],
): ModelProvider | undefined {
  const apiKey = apiKeyFor(provider, model?.apiKey);
  if (apiKey === undefined) return undefined;
  const modelName = model?.name ?? optionalString(process.env.REEF_MODEL_NAME);
  if (provider === "anthropic") {
    return new AnthropicProvider({
      apiKey,
      ...(modelName !== undefined ? { model: modelName } : {}),
    });
  }
  const region = optionalString(process.env.REEF_MODEL_REGION);
  return new BedrockProvider({
    token: apiKey,
    ...(modelName !== undefined ? { model: modelName } : {}),
    ...(region !== undefined ? { region } : {}),
  });
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** A local daemon hosting the Reef engine for every surface to share. */
export class ReefServer {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #fleets = new Map<string, ManagerFleetRecord>();
  readonly #options: ReefServerOptions;
  readonly #http: Server;
  readonly #powers: McpPowerRegistry;
  readonly #hooks: HookRegistry;
  readonly #specs: SpecRegistry;
  readonly #steering: SteeringRegistry;
  readonly #account: AccountStore;
  #counter = 0;
  #fleetCounter = 0;

  constructor(options: ReefServerOptions = {}) {
    this.#options = options;
    this.#powers = new McpPowerRegistry(options.persistDir);
    this.#hooks = new HookRegistry(options.persistDir);
    this.#specs = new SpecRegistry(options.persistDir);
    this.#steering = new SteeringRegistry(options.persistDir);
    this.#account = new AccountStore(options.persistDir);
    this.#http = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        this.#fail(res, 500, err instanceof Error ? err.message : String(err));
      });
    });
    // Bound resource use against an unauthenticated client: cap concurrent
    // sockets, and time out slow/idle request headers + bodies (an SSE response
    // is long-lived, but the REQUEST that opened it must arrive promptly).
    this.#http.maxConnections = 1024;
    this.#http.headersTimeout = 15_000;
    this.#http.requestTimeout = 30_000;
  }

  #maxSessions(): number {
    return this.#options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  #edition(): ReefEdition {
    const configured =
      this.#options.edition ??
      (process.env.REEF_EDITION === "commercial" ? "commercial" : undefined);
    return configured === "commercial" ? "commercial" : "community";
  }

  #editionResponse(): EditionResponse {
    const edition = this.#edition();
    const commercial = edition === "commercial";
    return {
      edition,
      providers: {
        byok: ["anthropic", "bedrock"],
        gateway: {
          available: commercial,
          gated: true,
          reason: commercial
            ? "Gateway provider is commercial-only and gated until entitlement verifies."
            : "Gateway provider is not compiled into the community surface.",
        },
      },
      commercialSurfaces: {
        available: commercial,
        gated: true,
        reason: commercial
          ? "Commercial surfaces are visible but gated without a local license."
          : "Commercial surfaces are omitted from the community edition.",
      },
    };
  }

  #usageSummary() {
    return usageSummary({
      ...(this.#options.persistDir !== undefined
        ? { persistDir: this.#options.persistDir }
        : {}),
      sessions: [...this.#sessions.values()].map((rec) => ({
        id: rec.id,
        task: rec.task,
        events: rec.events,
      })),
    });
  }

  async #accountPlan(
    request: AccountSnapshotRequest = {},
  ): Promise<AccountPlanResponse> {
    const account = this.#account.current();
    const plan = await accountPlan({
      edition: this.#edition(),
      usage: this.#usageSummary(),
      ...(account !== undefined ? { account } : {}),
      request,
    });
    return { ...plan, audit: this.#teamAudit(plan.team) };
  }

  #teamAudit(team: AccountPlanResponse["team"]): AccountPlanResponse["audit"] {
    if (team.gated || team.id === undefined) {
      return {
        gated: true,
        source: team.source,
        message:
          "Sign in through local stub SSO before team evidence is available.",
        sessions: [],
      };
    }
    return {
      gated: false,
      source: "persisted Reef evidence chains",
      message:
        "Each result is reloaded and verified from its persisted work spine and evidence log.",
      sessions: teamAuditSessions(this.#options.persistDir, team.id),
    };
  }

  /** Start listening. Pass 0 for an ephemeral port; resolves with the bound port. */
  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(port, host, () => {
        const addr = this.#http.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  /** Stop listening and end every open stream. */
  close(): Promise<void> {
    for (const rec of this.#sessions.values()) {
      for (const res of rec.subscribers) res.end();
      rec.subscribers.clear();
    }
    return new Promise((resolve) => this.#http.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (method === "GET" && parts.length === 1 && parts[0] === "health") {
      return this.#json(res, 200, { ok: true });
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "edition") {
      return this.#json(res, 200, this.#editionResponse());
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "usage") {
      return this.#json(res, 200, this.#usageSummary());
    }
    if (parts[0] === "account") {
      if (method === "GET" && parts.length === 1) {
        return this.#json(res, 200, await this.#accountPlan(accountQuery(url)));
      }
      if (method === "POST" && parts.length === 2 && parts[1] === "login") {
        try {
          const body = (await this.#readJson(req)) as AccountLoginRequest;
          await this.#account.login({
            ...body,
            ...(body.ssoUrl === undefined &&
            accountQuery(url).ssoUrl !== undefined
              ? { ssoUrl: accountQuery(url).ssoUrl }
              : {}),
          });
          const evidenceSessionId = this.#startSession({
            task: "OIDC SSO sign-in and team entitlement",
            persist: true,
            account: accountQuery(url),
          });
          const plan = await this.#accountPlan(accountQuery(url));
          return this.#json(res, 200, { ...plan, evidenceSessionId });
        } catch (err) {
          return this.#fail(
            res,
            400,
            err instanceof Error ? err.message : "bad body",
          );
        }
      }
      if (method === "POST" && parts.length === 2 && parts[1] === "logout") {
        this.#account.logout();
        return this.#json(res, 200, await this.#accountPlan(accountQuery(url)));
      }
    }
    if (parts[0] === "powers") {
      if (method === "GET" && parts.length === 1) {
        return this.#json(res, 200, this.#powers.list());
      }
      if (method === "POST" && parts.length === 2 && parts[1] === "install") {
        let body: { readonly id?: unknown };
        try {
          body = (await this.#readJson(req)) as { readonly id?: unknown };
          const id = optionalString(body.id);
          if (id === undefined) throw new Error("id is required");
          return this.#json(res, 201, {
            installed: this.#powers.installAvailable(id),
          });
        } catch (err) {
          return this.#fail(
            res,
            400,
            err instanceof Error ? err.message : "bad body",
          );
        }
      }
      if (method === "POST" && parts.length === 2 && parts[1] === "custom") {
        try {
          const body = (await this.#readJson(req)) as AddCustomPowerRequest;
          return this.#json(res, 201, {
            installed: this.#powers.addCustom(body),
          });
        } catch (err) {
          return this.#fail(
            res,
            400,
            err instanceof Error ? err.message : "bad body",
          );
        }
      }
    }
    if (parts[0] === "specs") {
      if (method === "GET" && parts.length === 1) {
        try {
          return this.#json(res, 200, this.#specs.list());
        } catch (err) {
          return this.#fail(
            res,
            500,
            err instanceof Error ? err.message : "could not list specs",
          );
        }
      }
      if (method === "POST" && parts.length === 1) {
        try {
          const body = (await this.#readJson(req)) as CreateSpecRequest;
          return this.#json(res, 201, { spec: this.#specs.create(body) });
        } catch (err) {
          return this.#fail(
            res,
            400,
            err instanceof Error ? err.message : "bad body",
          );
        }
      }
      const specId = parts[1];
      if (specId !== undefined && method === "GET" && parts.length === 2) {
        try {
          return this.#json(res, 200, this.#specs.get(specId));
        } catch (err) {
          return this.#fail(
            res,
            404,
            err instanceof Error ? err.message : "unknown spec",
          );
        }
      }
      if (
        specId !== undefined &&
        method === "GET" &&
        parts.length === 3 &&
        parts[2] === "verify"
      ) {
        try {
          return this.#json(res, 200, this.#specs.verify(specId));
        } catch (err) {
          return this.#fail(
            res,
            404,
            err instanceof Error ? err.message : "unknown spec",
          );
        }
      }
      if (
        specId !== undefined &&
        method === "POST" &&
        parts.length === 3 &&
        parts[2] === "advance"
      ) {
        try {
          const body = (await this.#readJson(req)) as AdvanceSpecRequest;
          return this.#json(res, 200, this.#specs.advance(specId, body));
        } catch (err) {
          return this.#fail(
            res,
            400,
            err instanceof Error ? err.message : "bad body",
          );
        }
      }
    }
    if (parts[0] === "steering") {
      if (method === "GET" && parts.length === 1) {
        return this.#json(res, 200, this.#steering.list());
      }
      if (method === "POST" && parts.length === 2 && parts[1] === "active") {
        try {
          const body = (await this.#readJson(req)) as SetSteeringActiveRequest;
          return this.#json(res, 200, this.#steering.setActive(body));
        } catch (err) {
          return this.#fail(
            res,
            400,
            err instanceof Error ? err.message : "bad body",
          );
        }
      }
      if (method === "POST" && parts.length === 2 && parts[1] === "custom") {
        try {
          const body = (await this.#readJson(req)) as AddCustomSteeringRequest;
          return this.#json(res, 201, {
            steering: this.#steering.addCustom(body),
          });
        } catch (err) {
          return this.#fail(
            res,
            400,
            err instanceof Error ? err.message : "bad body",
          );
        }
      }
    }
    if (parts[0] === "hooks") {
      if (method === "GET" && parts.length === 1) {
        return this.#json(res, 200, this.#hooks.list());
      }
      if (method === "POST" && parts.length === 1) {
        try {
          const body = (await this.#readJson(req)) as CreateHookRequest;
          return this.#json(res, 201, { hook: this.#hooks.create(body) });
        } catch (err) {
          return this.#fail(
            res,
            400,
            err instanceof Error ? err.message : "bad body",
          );
        }
      }
      const hookId = parts[1];
      if (
        hookId !== undefined &&
        method === "POST" &&
        parts.length === 3 &&
        parts[2] === "fire"
      ) {
        try {
          const body = (await this.#readJson(req)) as FireHookRequest;
          const fired = this.#hooks.fire(hookId, body);
          const sessionId = this.#startSession({
            task: fired.hook.task,
            persist: body.persist !== false,
            hook: {
              id: fired.hook.id,
              name: fired.hook.name,
              trigger: fired.hook.trigger,
              event: fired.event,
            },
          });
          return this.#json(res, 201, { hook: fired.hook, sessionId });
        } catch (err) {
          return this.#fail(
            res,
            err instanceof RequestFailure ? err.status : 400,
            err instanceof Error ? err.message : "bad body",
          );
        }
      }
    }
    if (parts[0] === "manager" && parts[1] === "fleets") {
      if (method === "POST" && parts.length === 2) {
        return this.#createManagerFleet(req, res);
      }
      const fleetId = parts[2];
      if (fleetId !== undefined) {
        const fleet = this.#fleets.get(fleetId);
        if (fleet === undefined) return this.#fail(res, 404, "unknown fleet");
        if (method === "GET" && parts.length === 3) {
          return this.#json(res, 200, this.#fleetView(fleet));
        }
        if (method === "GET" && parts.length === 4 && parts[3] === "ledger") {
          return this.#json(res, 200, this.#fleetLedgerBody(fleet));
        }
        if (method === "GET" && parts.length === 4 && parts[3] === "verify") {
          return this.#json(res, 200, this.#verifyFleet(fleet));
        }
      }
    }
    if (method === "POST" && parts.length === 1 && parts[0] === "sessions") {
      return this.#createSession(req, res);
    }
    if (parts[0] === "sessions" && parts.length >= 2) {
      const rec = this.#sessions.get(parts[1]!);
      if (rec === undefined) return this.#fail(res, 404, "unknown session");
      if (method === "GET" && parts.length === 2) {
        return this.#json(res, 200, this.#view(rec));
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "events") {
        return this.#subscribe(req, res, rec);
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "verify") {
        return this.#verify(res, rec);
      }
      if (method === "POST" && parts.length === 3 && parts[2] === "tamper") {
        return this.#tamperSession(res, rec);
      }
    }
    // Non-API GETs fall through to the static SPA, when one is configured.
    if (method === "GET" && this.#options.staticDir !== undefined) {
      return this.#serveStatic(this.#options.staticDir, url.pathname, res);
    }
    this.#fail(res, 404, "not found");
  }

  #serveStatic(dir: string, pathname: string, res: ServerResponse): void {
    const root = resolve(dir);
    const requested = resolve(root, `.${pathname}`);
    // Path-traversal guard: never serve outside the static root.
    const rel = relative(root, requested);
    const inRoot =
      rel === "" || (!rel.startsWith("..") && !/^([a-zA-Z]:)?[/\\]/.test(rel));
    let file = inRoot ? requested : root;
    // A directory or an unknown client-route path → the SPA entry point.
    if (!existsSync(file) || statSync(file).isDirectory()) {
      file = join(root, "index.html");
    }
    if (!existsSync(file)) return this.#fail(res, 404, "not found");
    const body = readFileSync(file);
    res.writeHead(200, {
      "Content-Type":
        CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  }

  async #createSession(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = (await this.#readJson(req)) as CreateSessionRequest;
      return this.#json(res, 201, { id: this.#startSession(body) });
    } catch (err) {
      return this.#fail(
        res,
        err instanceof RequestFailure ? err.status : 400,
        err instanceof Error ? err.message : "bad body",
      );
    }
  }

  async #createManagerFleet(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = (await this.#readJson(req)) as CreateManagerFleetRequest;
      const tasks = (Array.isArray(body.tasks) ? body.tasks : [])
        .map((task) => (typeof task === "string" ? task.trim() : ""))
        .filter((task) => task !== "");
      if (tasks.length < 2) {
        throw new RequestFailure(
          400,
          "manager fleet requires at least two tasks",
        );
      }
      const id = `fleet-${(this.#fleetCounter++).toString(36)}-${Date.now().toString(36)}`;
      const createdAt = new Date().toISOString();
      const sessionIds = tasks.map((task) =>
        this.#startSession({
          task,
          persist: body.persist === true,
          ...(typeof body.secret === "string" && body.secret.length > 0
            ? { secret: body.secret }
            : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
        }),
      );
      const fleet: ManagerFleetRecord = {
        id,
        createdAt,
        updatedAt: createdAt,
        sessionIds,
        status: "running",
        ledger: null,
        ledgerHead: null,
        ledgerVerified: null,
      };
      this.#fleets.set(id, fleet);
      void this.#completeFleet(fleet);
      return this.#json(res, 201, { fleet: this.#fleetView(fleet) });
    } catch (err) {
      return this.#fail(
        res,
        err instanceof RequestFailure ? err.status : 400,
        err instanceof Error ? err.message : "bad body",
      );
    }
  }

  async #completeFleet(fleet: ManagerFleetRecord): Promise<void> {
    try {
      const sessions = fleet.sessionIds
        .map((id) => this.#sessions.get(id))
        .filter((rec): rec is SessionRecord => rec !== undefined);
      await Promise.all(sessions.map((rec) => rec.sealed));
      const ledger = await this.#buildFleetLedger(fleet, sessions);
      fleet.ledger = ledger.ledger;
      fleet.ledgerHead = ledger.head;
      fleet.ledgerVerified = ledger.verified;
    } catch {
      fleet.ledger = null;
      fleet.ledgerHead = null;
      fleet.ledgerVerified = false;
    } finally {
      fleet.status = "sealed";
      fleet.updatedAt = new Date().toISOString();
      this.#persistFleet(fleet);
    }
  }

  async #buildFleetLedger(
    fleet: ManagerFleetRecord,
    sessions: readonly SessionRecord[],
  ): Promise<{
    readonly ledger: WorkerLedger;
    readonly head: string;
    readonly verified: boolean;
  }> {
    const subtasks: Subtask[] = sessions.map((session) => ({
      id: session.id,
      description: session.task,
    }));
    const results = sessions.map((session) =>
      this.#workerResultForSession(session),
    );
    let index = 0;
    let tick = 0;
    const planner: Planner = { plan: () => Promise.resolve(subtasks) };
    const router: Router = {
      route: () =>
        Promise.resolve({
          worker: "manager-session",
          reason: "parallel governed session sealed and ready to verify",
        }),
    };
    const worker: Worker = {
      name: "manager-session",
      description:
        "Binds a sealed governed background session into the Manager Worker Ledger.",
      run: () => {
        const result = results[index++];
        if (result === undefined) throw new Error("manager-session exhausted");
        return Promise.resolve(result);
      },
    };
    const orchestrator = new Orchestrator({
      workers: [worker],
      planner,
      router,
      now: () => {
        const base = new Date().toISOString().replace(/Z$/, "");
        return `${base}.${String(tick++).padStart(3, "0")}Z`;
      },
      acceptance: {
        contractHash: fleet.id,
        contract: {
          kind: "reef.manager.fleet",
          fleetId: fleet.id,
          requires: [
            "each background governed session verifies",
            "each result pins its work and evidence heads",
            "the fleet Worker Ledger verifies",
          ],
        },
        judge: (_task, steps) =>
          Promise.resolve({
            met: steps.every((step) => step.result.verified),
            reason: "all Manager sessions produced verified governed proofs",
          }),
      },
    });
    const result = await orchestrator.orchestrate(`manager fleet ${fleet.id}`);
    return {
      ledger: result.ledger,
      head: ledgerHead(result.ledger),
      verified: verifyLedger(result.ledger),
    };
  }

  #workerResultForSession(rec: SessionRecord): WorkerResult {
    const seal = [...rec.events]
      .reverse()
      .find((event) => event.kind === "session.sealed");
    const reason = seal?.data["reason"];
    return {
      outcome: rec.outcome ?? "failed",
      output:
        typeof reason === "string" && reason.length > 0
          ? reason
          : `manager session ${rec.id}`,
      workHead: rec.session.graph.anchor().head,
      logHead: rec.session.log.head,
      verified: this.#verifySessionRecord(rec).ok,
      record: recordOf(rec.session),
    };
  }

  #fleetDir(fleet: ManagerFleetRecord): string | undefined {
    return this.#options.persistDir === undefined
      ? undefined
      : join(this.#options.persistDir, "fleets", fleet.id);
  }

  #persistFleet(fleet: ManagerFleetRecord): void {
    const dir = this.#fleetDir(fleet);
    if (dir === undefined) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "fleet.json"),
      `${JSON.stringify(this.#fleetView(fleet), null, 2)}\n`,
    );
    if (fleet.ledger !== null) {
      writeFileSync(
        join(dir, "worker-ledger.json"),
        `${JSON.stringify(
          {
            fleetId: fleet.id,
            sessionIds: fleet.sessionIds,
            ledger: fleet.ledger,
            head: fleet.ledgerHead,
            verified: fleet.ledgerVerified,
          },
          null,
          2,
        )}\n`,
      );
    }
  }

  #readPersistedFleetLedger(fleet: ManagerFleetRecord):
    | {
        readonly ledger: WorkerLedger;
        readonly source: "persisted";
      }
    | undefined {
    const dir = this.#fleetDir(fleet);
    if (dir === undefined) return undefined;
    const path = join(dir, "worker-ledger.json");
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      readonly ledger?: WorkerLedger;
    };
    if (parsed.ledger === undefined) return undefined;
    return { ledger: parsed.ledger, source: "persisted" };
  }

  #fleetLedgerBody(fleet: ManagerFleetRecord): {
    readonly ledger: WorkerLedger | null;
    readonly view: ManagerFleetLedgerView | null;
  } {
    const loaded = this.#readPersistedFleetLedger(fleet);
    const ledger = loaded?.ledger ?? fleet.ledger;
    if (ledger === null) return { ledger: null, view: null };
    const verified = verifyLedger(ledger);
    return {
      ledger,
      view: {
        head: ledgerHead(ledger),
        links: ledger.chain.length,
        verified,
        source: loaded?.source ?? "memory",
      },
    };
  }

  #sessionCard(rec: SessionRecord): ManagerSessionCardView {
    const verify =
      rec.status === "sealed" ? this.#verifySessionRecord(rec) : rec.verify;
    return {
      id: rec.id,
      task: rec.task,
      status: rec.status,
      outcome: rec.outcome,
      events: rec.events.length,
      verifyOk: verify?.ok ?? null,
      verify,
      ...(rec.snapshot !== null
        ? {
            logHead: rec.snapshot.logHead,
            workChainLength: rec.snapshot.workChainLength,
            logChainLength: rec.snapshot.logChainLength,
          }
        : {}),
    };
  }

  #fleetView(fleet: ManagerFleetRecord): ManagerFleetView {
    let ledger: ManagerFleetLedgerView | null;
    try {
      ledger = this.#fleetLedgerBody(fleet).view;
    } catch {
      ledger =
        fleet.ledgerHead === null
          ? null
          : {
              head: fleet.ledgerHead,
              links: fleet.ledger?.chain.length ?? 0,
              verified: false,
              source: "persisted",
            };
    }
    return {
      id: fleet.id,
      status: fleet.status,
      createdAt: fleet.createdAt,
      updatedAt: fleet.updatedAt,
      sessions: fleet.sessionIds
        .map((id) => this.#sessions.get(id))
        .filter((rec): rec is SessionRecord => rec !== undefined)
        .map((rec) => this.#sessionCard(rec)),
      ledger,
    };
  }

  #verifyFleet(fleet: ManagerFleetRecord): ManagerFleetVerifyResponse {
    const sessions = fleet.sessionIds
      .map((id) => this.#sessions.get(id))
      .filter((rec): rec is SessionRecord => rec !== undefined)
      .map((rec) => this.#sessionCard(rec));
    let ledger: ManagerFleetLedgerView | null = null;
    let ledgerOk = false;
    let ledgerReason = "fleet ledger has not sealed yet";
    if (fleet.status === "sealed") {
      try {
        const body = this.#fleetLedgerBody(fleet);
        ledger = body.view;
        ledgerOk = ledger?.verified === true;
        ledgerReason = ledgerOk
          ? "fleet Worker Ledger verified"
          : "fleet Worker Ledger failed verification";
      } catch (err) {
        ledger =
          fleet.ledgerHead === null
            ? null
            : {
                head: fleet.ledgerHead,
                links: fleet.ledger?.chain.length ?? 0,
                verified: false,
                source: "persisted",
              };
        ledgerReason = err instanceof Error ? err.message : String(err);
      }
    }
    const sessionsOk =
      sessions.length > 0 &&
      sessions.every((session) => session.verifyOk === true);
    const ok = fleet.status === "sealed" && ledgerOk && sessionsOk;
    return {
      ok,
      ledger,
      sessions,
      reason: ok
        ? "fleet ledger and all governed sessions verified"
        : `${ledgerReason}; sessions ${sessionsOk ? "verified" : "failed verification"}`,
    };
  }

  #startSession(body: CreateSessionRequest): string {
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (task === "") throw new RequestFailure(400, "task is required");

    // Bound memory: evict the oldest SEALED session when at capacity (Map
    // iteration is insertion order). If everything resident is still running,
    // refuse rather than grow without bound.
    if (this.#sessions.size >= this.#maxSessions()) {
      let evicted = false;
      for (const [key, old] of this.#sessions) {
        if (old.status === "sealed") {
          this.#sessions.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) throw new RequestFailure(503, "too many active sessions");
    }

    const id = `sess-${(this.#counter++).toString(36)}-${Date.now().toString(36)}`;
    const baseContext = sessionContext(task, body, this.#edition());
    // Flow a signed-in account's hosted-gateway token into the session when the
    // request didn't set one explicitly, so "Sign in" then "Run" reaches the gateway.
    const signedIn = this.#account.current();
    const context =
      signedIn?.licenseToken !== undefined &&
      baseContext.model?.licenseToken === undefined &&
      baseContext.model?.accessToken === undefined
        ? {
            ...baseContext,
            model: {
              ...(baseContext.model ?? {}),
              licenseToken: signedIn.licenseToken,
            },
          }
        : baseContext;
    const runtimeBase =
      body.account !== undefined
        ? this.#accountRuntime(body.account)
        : body.spec !== undefined
          ? this.#specRuntime(body.spec)
          : body.browser !== undefined
            ? this.#browserRuntime(body.browser)
            : body.mcp !== undefined
              ? this.#mcpRuntime(body.mcp)
              : normalizeRuntime(
                  this.#options.driverFactory?.(context) ??
                    defaultRuntime(context),
                );
    const steeredRuntime = this.#steeredRuntime(runtimeBase, body.steering);
    const hookedRuntime = this.#hookedRuntime(steeredRuntime, body.hook);
    const conversationalRuntime = this.#conversationRuntime(
      hookedRuntime,
      body.conversation,
    );
    const runtime = this.#teamRuntime(conversationalRuntime);
    let finish!: () => void;
    const sealed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const rec: SessionRecord = {
      id,
      task,
      session: undefined as unknown as GovernedSession,
      events: [],
      subscribers: new Set(),
      sealed,
      finish,
      status: "running",
      snapshot: null,
      verify: null,
      outcome: null,
      ...(runtime.cleanup !== undefined ? { cleanup: runtime.cleanup } : {}),
    };
    rec.session = new GovernedSession({
      id,
      task,
      driver: runtime.driver,
      ...(runtime.authorizer !== undefined
        ? { authorizer: runtime.authorizer }
        : {}),
      ...(runtime.executor !== undefined ? { executor: runtime.executor } : {}),
      ...(typeof body.secret === "string" && body.secret.length > 0
        ? { integritySecret: body.secret }
        : {}),
      onEvent: (event) => {
        rec.events.push(event);
        this.#broadcast(rec, { type: "event", event });
      },
    });
    this.#sessions.set(id, rec);
    void this.#run(rec, body.persist === true);
    return id;
  }

  #accountRuntime(request: AccountSessionRequest): SessionRuntime {
    return {
      driver: new AccountPlanDriver(() => this.#accountPlan(request)),
    };
  }

  #teamRuntime(runtime: SessionRuntime): SessionRuntime {
    const context = accountGovernanceContext(
      this.#edition(),
      this.#account.current(),
    );
    if (context.team.gated || context.sso.state !== "signed-in") return runtime;
    return {
      ...runtime,
      driver: new TeamEvidenceDriver(runtime.driver, context),
    };
  }

  #mcpRuntime(request: McpSessionRequest): SessionRuntime {
    const serverId = optionalString(request.serverId) ?? "reef-echo";
    const requestedTool =
      optionalString(request.tool) ??
      (request.expectDenied === true ? "reverse" : "echo");
    const power = this.#powers.get(serverId);
    if (power === undefined) {
      return {
        driver: new ConfigurationFailureDriver(
          `MCP power '${serverId}' is not installed`,
        ),
      };
    }

    const tool = this.#powers.fullToolName(power.id, requestedTool);
    const tools = this.#powers.toolsFor(power);
    if (!tools.some((candidate) => candidate.name === tool)) {
      return {
        driver: new ConfigurationFailureDriver(
          `MCP power '${power.name}' does not expose tool '${requestedTool}'`,
        ),
      };
    }

    return {
      driver: new McpDemoDriver({
        tool,
        input: request.input ?? { text: "offline N5" },
        ...(request.expectDenied !== undefined
          ? { expectDenied: request.expectDenied }
          : {}),
      }),
      authorizer: reefAllowlist({
        tools: this.#powers.allowedFullToolNames(power),
      }),
      executor: new ToolExecutor(tools),
    };
  }

  #browserRuntime(request: BrowserSessionRequest): SessionRuntime {
    const browser = new BrowserPowerRuntime(request.url);
    const tool = optionalString(request.tool);
    const allowed = browser
      .allowedTools()
      .filter((name) => request.expectDenied !== true || name !== tool);
    return {
      driver: new BrowserDemoDriver({
        ...(request.url !== undefined ? { url: request.url } : {}),
        ...(tool !== undefined ? { tool } : {}),
        ...(request.selector !== undefined
          ? { selector: request.selector }
          : {}),
        ...(request.annotation !== undefined
          ? { annotation: request.annotation }
          : {}),
        ...(request.expectDenied !== undefined
          ? { expectDenied: request.expectDenied }
          : {}),
      }),
      authorizer: reefAllowlist({ tools: allowed }),
      executor: new ToolExecutor(browser.tools()),
      cleanup: () => browser.close(),
    };
  }

  #specRuntime(request: SpecSessionRequest): SessionRuntime {
    const specId = optionalString(request.specId);
    const itemId = optionalString(request.itemId);
    const to = optionalString(request.to);
    if (specId === undefined || itemId === undefined || to === undefined) {
      return {
        driver: new ConfigurationFailureDriver(
          "spec session requires specId, itemId, and to",
        ),
      };
    }

    const input = {
      specId,
      itemId,
      to,
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    };
    const tool: Tool = {
      name: "reef-spec.advance",
      description:
        "Advance a Reef spec task through the octopus-workstate state machine.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          itemId: { type: "string" },
          to: { type: "string" },
          reason: { type: "string" },
        },
        required: ["specId", "itemId", "to"],
        additionalProperties: false,
      },
      run: async (raw: JsonValue) => {
        const body = jsonObject(raw);
        try {
          const advanced = this.#specs.advance(String(body.specId ?? ""), {
            itemId: String(body.itemId ?? ""),
            to: String(body.to ?? ""),
            ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
          });
          return {
            ok: true,
            output: JSON.stringify({
              specId: advanced.spec.id,
              itemId: advanced.transition.itemId,
              from: advanced.transition.from,
              to: advanced.transition.to,
              transitionEvidenceId: advanced.transition.evidenceId,
              sequence: advanced.transition.sequence,
            }),
          };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };

    return {
      driver: new SpecAdvanceDriver({ specId, itemId, to, input }),
      authorizer: reefAllowlist({ tools: [tool.name] }),
      executor: new ToolExecutor([tool]),
    };
  }

  #steeredRuntime(
    runtime: SessionRuntime,
    request: SteeringSessionRequest | undefined,
  ): SessionRuntime {
    const items = this.#steering.activeItems(request?.ids);
    if (items.length === 0) return runtime;
    return {
      ...runtime,
      driver: new SteeringDriver(runtime.driver, items),
    };
  }

  #hookedRuntime(
    runtime: SessionRuntime,
    request: HookSessionRequest | undefined,
  ): SessionRuntime {
    if (request === undefined) return runtime;
    return {
      ...runtime,
      driver: new HookDriver(runtime.driver, request),
    };
  }

  #validatedConversation(
    request: ConversationSessionRequest,
  ): ConversationSessionRequest | string {
    const normalized: {
      id?: string;
      turn?: number;
      parentSessionId?: string;
      autopilot?: boolean;
      approvalMode?: "auto" | "ask";
      command?: ChatCommandResolution;
      taskRef?: ChatTaskReference;
      route?: ChatRouteResolution;
    } = {
      ...(request.id !== undefined ? { id: request.id } : {}),
      ...(request.turn !== undefined ? { turn: request.turn } : {}),
      ...(request.parentSessionId !== undefined
        ? { parentSessionId: request.parentSessionId }
        : {}),
      ...(request.autopilot !== undefined
        ? { autopilot: request.autopilot }
        : {}),
      ...(request.approvalMode !== undefined
        ? { approvalMode: request.approvalMode }
        : {}),
    };

    if (request.command !== undefined) {
      const id = optionalString(request.command.id);
      const token = optionalString(request.command.token);
      const label = optionalString(request.command.label);
      if (id === undefined || !CHAT_COMMAND_IDS.has(id)) {
        return `unknown Reef chat command '${id ?? ""}'`;
      }
      if (token !== `/${id}` || label === undefined) {
        return `invalid Reef chat command metadata for '${id}'`;
      }
      normalized.command = {
        id: id as ChatCommandResolution["id"],
        token,
        label,
      };
    }

    if (request.route !== undefined) {
      const token = optionalString(request.route.token);
      const route = token === undefined ? undefined : CHAT_ROUTES.get(token);
      const label = optionalString(request.route.label);
      if (token === undefined || route === undefined) {
        return `unknown Reef role-agent route '${token ?? ""}'`;
      }
      if (
        request.route.worker !== route.worker ||
        (route.cli !== undefined && request.route.cli !== route.cli) ||
        (route.cli === undefined && request.route.cli !== undefined) ||
        label === undefined
      ) {
        return `invalid Reef role-agent route metadata for '${token}'`;
      }
      normalized.route = {
        token,
        worker: route.worker,
        label,
        ...(route.cli !== undefined ? { cli: route.cli } : {}),
      };
    }

    if (request.taskRef !== undefined) {
      const specId = optionalString(request.taskRef.specId);
      const itemId = optionalString(request.taskRef.itemId);
      if (specId === undefined || itemId === undefined) {
        return "Reef task reference requires specId and itemId";
      }
      let spec;
      try {
        spec = this.#specs.get(specId);
      } catch {
        return `unknown Reef spec task '${itemId}'`;
      }
      const task = spec.tasks.find((candidate) => candidate.id === itemId);
      if (task === undefined || task.state === "done") {
        return `unknown or closed Reef spec task '${itemId}'`;
      }
      normalized.taskRef = {
        specId,
        itemId,
        title: task.title,
        state: task.state,
        ...(task.history.at(-1)?.evidenceId !== undefined
          ? { evidenceId: task.history.at(-1)!.evidenceId }
          : {}),
      };
    }

    return normalized;
  }

  #conversationRuntime(
    runtime: SessionRuntime,
    request: ConversationSessionRequest | undefined,
  ): SessionRuntime {
    if (request === undefined) return runtime;
    const validated = this.#validatedConversation(request);
    if (typeof validated === "string") {
      return {
        ...runtime,
        driver: new ConfigurationFailureDriver(validated),
      };
    }
    return {
      ...runtime,
      driver: new ConversationDriver(runtime.driver, validated),
    };
  }

  async #run(rec: SessionRecord, persist: boolean): Promise<void> {
    try {
      const result = await rec.session.run();
      rec.snapshot = result.snapshot;
      rec.outcome = result.outcome;
    } catch {
      rec.outcome = "failed";
    }
    rec.verify = rec.session.verify();
    rec.status = "sealed";
    if (persist && this.#options.persistDir !== undefined) {
      try {
        persistSession(rec.session, join(this.#options.persistDir, rec.id));
      } catch {
        /* persistence is best-effort; the live session still verifies */
      }
    }
    if (rec.snapshot !== null) {
      this.#broadcast(rec, {
        type: "sealed",
        snapshot: rec.snapshot,
        verify: rec.verify,
      });
    }
    for (const res of rec.subscribers) res.end();
    rec.subscribers.clear();
    try {
      rec.cleanup?.();
    } finally {
      rec.finish();
    }
  }

  #subscribe(
    req: IncomingMessage,
    res: ServerResponse,
    rec: SessionRecord,
  ): void {
    // A running session only ever holds a bounded set of live subscribers; a
    // sealed one replays + closes immediately (no retained socket) so it's exempt.
    const max = this.#options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
    if (rec.status !== "sealed" && rec.subscribers.size >= max) {
      return this.#fail(res, 429, "too many subscribers for this session");
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    // No `await` below this point: the handler runs to completion atomically, so
    // no live event can interleave between the replay and the subscription.
    this.#send(res, { type: "hello", id: rec.id, task: rec.task });
    for (const event of rec.events) this.#send(res, { type: "event", event });
    if (rec.status === "sealed") {
      if (rec.snapshot !== null && rec.verify !== null) {
        this.#send(res, {
          type: "sealed",
          snapshot: rec.snapshot,
          verify: rec.verify,
        });
      }
      res.end();
      return;
    }
    rec.subscribers.add(res);
    req.on("close", () => rec.subscribers.delete(res));
  }

  #verify(res: ServerResponse, rec: SessionRecord): void {
    if (rec.status !== "sealed") {
      this.#fail(res, 409, "session has not sealed yet");
      return;
    }
    this.#json(res, 200, this.#verifySessionRecord(rec));
  }

  #tamperSession(res: ServerResponse, rec: SessionRecord): void {
    if (rec.status !== "sealed") {
      this.#fail(res, 409, "session has not sealed yet");
      return;
    }
    if (this.#options.persistDir === undefined) {
      this.#fail(res, 409, "session tamper demo requires persisted sessions");
      return;
    }
    const logPath = join(this.#options.persistDir, rec.id, "session.log.jsonl");
    if (!existsSync(logPath)) {
      this.#fail(res, 404, "persisted session log not found");
      return;
    }
    const raw = readFileSync(logPath);
    const offset = raw.findIndex((byte) => byte !== 0x0a && byte !== 0x0d);
    if (offset < 0) {
      this.#fail(res, 500, "persisted session log was empty");
      return;
    }
    raw[offset] = raw[offset] === 0x61 ? 0x62 : 0x61;
    writeFileSync(logPath, raw);
    this.#json(res, 200, {
      tampered: true,
      artifact: "session.log.jsonl",
      offset,
      verify: this.#verifySessionRecord(rec),
    });
  }

  #verifySessionRecord(rec: SessionRecord): VerifyResult {
    const persisted =
      this.#options.persistDir !== undefined
        ? join(this.#options.persistDir, rec.id)
        : undefined;
    if (
      persisted !== undefined &&
      existsSync(join(persisted, "session.log.jsonl"))
    ) {
      try {
        loadSession(persisted);
        return {
          ok: true,
          work: "intact",
          log: "intact",
          binding: "bound",
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          work: "unchecked",
          log: `broken: ${reason}`,
          binding: "unchecked",
        };
      }
    }
    // Re-verify from scratch — store-untrusting, exactly as an offline auditor would.
    return rec.session.verify();
  }

  #view(rec: SessionRecord): SessionView {
    return {
      id: rec.id,
      task: rec.task,
      status: rec.status,
      outcome: rec.outcome,
      snapshot: rec.snapshot,
      verify: rec.verify,
      events: rec.events.length,
    };
  }

  #broadcast(rec: SessionRecord, frame: ServerEvent): void {
    for (const res of rec.subscribers) this.#send(res, frame);
  }

  #send(res: ServerResponse, frame: ServerEvent): void {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(payload);
  }

  #fail(res: ServerResponse, status: number, error: string): void {
    if (!res.headersSent) this.#json(res, status, { error });
    else res.end();
  }

  #readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        if (raw.length > MAX_BODY) {
          reject(new Error("request body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (raw.trim() === "") return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }
}
