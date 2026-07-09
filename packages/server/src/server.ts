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
import { existsSync, readFileSync, statSync } from "node:fs";
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
  type ModelProvider,
} from "@octopus-reef/agent";
import {
  GatewayProvider,
  gatewayEntitlementDecision,
  gatewayQuotaDecision,
  gatewayRouteDecision,
  type GatewayEntitlementDecision,
  type GatewayQuotaDecision,
  type GatewayRouteDecision,
} from "@octopus-reef/commercial";
import type { JsonValue } from "octopus-evidence";
import type {
  AccountLoginRequest,
  AccountPlanResponse,
  AddCustomSteeringRequest,
  CreateHookRequest,
  CreateSessionRequest,
  EditionResponse,
  FireHookRequest,
  ReefEdition,
  SetSteeringActiveRequest,
  ServerEvent,
  SessionView,
  SteeringItemView,
  VerifyResult,
} from "@octopus-reef/protocol";
import {
  AccountPlanDriver,
  AccountStore,
  accountPlan,
  type AccountSnapshotRequest,
} from "./account.js";
import {
  McpPowerRegistry,
  type AddCustomPowerRequest,
  type InstalledPower,
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
  status: "running" | "sealed";
  snapshot: SessionSnapshot | null;
  verify: VerifyResult | null;
  outcome: SessionOutcome | null;
  cleanup?: () => void;
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
}

interface AccountSessionRequest {
  readonly provider?: string;
  readonly model?: string;
  readonly source?: string;
  readonly gatewayUrl?: string;
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
    };
    this.name = `${inner.name}+conversation`;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
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
    readonly gatewayUrl?: string;
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
    ...maybe("gatewayUrl", optionalString(modelBody?.gatewayUrl)),
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
  };
}

function maybe<T>(
  key: string,
  value: T | undefined,
): Record<string, T> | Record<string, never> {
  return value === undefined ? {} : { [key]: value };
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
  const entitlement = gatewayEntitlementDecision(
    licenseToken === undefined ? {} : { licenseToken },
  );
  const quota = gatewayQuotaDecision({
    entitlementAllowed: entitlement.allowed,
  });
  if (!entitlement.allowed || licenseToken === undefined) {
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

  const route = gatewayRouteDecision({
    gatewayUrl,
    licenseToken,
    ...(context.model?.name !== undefined ? { model: context.model.name } : {}),
  });
  const provider = new GatewayProvider({
    gatewayUrl,
    licenseToken,
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
  readonly #options: ReefServerOptions;
  readonly #http: Server;
  readonly #powers: McpPowerRegistry;
  readonly #hooks: HookRegistry;
  readonly #specs: SpecRegistry;
  readonly #steering: SteeringRegistry;
  readonly #account: AccountStore;
  #counter = 0;

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
    return await accountPlan({
      edition: this.#edition(),
      usage: this.#usageSummary(),
      ...(account !== undefined ? { account } : {}),
      request,
    });
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
          this.#account.login(body);
          return this.#json(
            res,
            200,
            await this.#accountPlan(accountQuery(url)),
          );
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
    const context = sessionContext(task, body, this.#edition());
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
    const runtime = this.#conversationRuntime(hookedRuntime, body.conversation);
    const rec: SessionRecord = {
      id,
      task,
      session: undefined as unknown as GovernedSession,
      events: [],
      subscribers: new Set(),
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

  #conversationRuntime(
    runtime: SessionRuntime,
    request: ConversationSessionRequest | undefined,
  ): SessionRuntime {
    if (request === undefined) return runtime;
    return {
      ...runtime,
      driver: new ConversationDriver(runtime.driver, request),
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
    rec.cleanup?.();
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
        this.#json(res, 200, {
          ok: true,
          work: "intact",
          log: "intact",
          binding: "bound",
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#json(res, 200, {
          ok: false,
          work: "unchecked",
          log: `broken: ${reason}`,
          binding: "unchecked",
        });
      }
      return;
    }
    // Re-verify from scratch — store-untrusting, exactly as an offline auditor would.
    this.#json(res, 200, rec.session.verify());
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
