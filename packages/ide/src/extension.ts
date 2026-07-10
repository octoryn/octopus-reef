/**
 * The Reef VS Code extension. Run a governed session from the command palette,
 * watch its tamper-evident evidence chain stream into a panel, and see it seal
 * and verify — the editor-native form of the same proof the CLI and web show.
 *
 * The extension host owns the daemon connection (fetch + SSE); the webview is
 * pure presentation, fed via postMessage.
 */
import * as vscode from "vscode";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  addCustomPower,
  addCustomSteering,
  advanceSpec,
  createSession,
  createSpec,
  createHook,
  fireHook,
  getAccount,
  createManagerFleet,
  getManagerFleet,
  getUsage,
  getSpec,
  installPower,
  loginAccount,
  listHooks,
  listPowers,
  listSpecs,
  listSteering,
  logoutAccount,
  setActiveSteering,
  streamEvents,
  verifySpec,
  verifyManagerFleet,
  verifySession,
  type AccountQuery,
  type ServerEvent,
} from "./client.js";
import {
  accountWebviewHtml,
  agentFocusWebviewHtml,
  browserWebviewHtml,
  hooksWebviewHtml,
  managerWebviewHtml,
  powersWebviewHtml,
  specsWebviewHtml,
  steeringWebviewHtml,
  usageWebviewHtml,
  welcomeWebviewHtml,
  webviewHtml,
} from "./webview.js";
import {
  buildFocusRunView,
  focusUsageSnapshot,
  type FocusRunView,
} from "./agentFocus.js";
import {
  chatApprovalLabel,
  chatConversationContext,
  chatModelChip,
  type ChatConversationContext,
} from "./chat.js";
import {
  CHAT_COMMANDS,
  CHAT_ROUTES,
  openTaskCandidates,
  resolveChatAffordances,
  type ChatTaskCandidate,
} from "./chatAffordances.js";
import {
  isWelcomeAction,
  shouldOpenReefWelcome,
  welcomeCommandForAction,
  type WelcomeAction,
} from "./welcome.js";
import type { WorkState } from "@octopus-reef/protocol";
import {
  reefEdition,
  registerCommercialSurface,
} from "./commercial/edition.js";

type SessionEvent = Extract<ServerEvent, { type: "event" }>["event"];
type SealedEvent = Extract<ServerEvent, { type: "sealed" }>;
type VerifyResult = SealedEvent["verify"];
type PriorityModelTier = "standard" | "priority";

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface ReefSurface {
  reveal(): void | Thenable<void>;
  reset(task: string): void;
  event(event: SessionEvent): void;
  sealed(event: SealedEvent): void;
  verified(verify: VerifyResult): void;
  error(message: string): void;
}

const REEF_SESSION_VIEW_ID = "reef.session";
const REEF_POWERS_VIEW_ID = "reef.powers";
const REEF_SPECS_VIEW_ID = "reef.specs";
const REEF_ACCOUNT_VIEW_ID = "reef.account";
const REEF_USAGE_VIEW_ID = "reef.usage";
const REEF_MANAGER_VIEW_ID = "reef.manager";
const REEF_STEERING_VIEW_ID = "reef.steering";
const REEF_HOOKS_VIEW_ID = "reef.hooks";
const REEF_BROWSER_VIEW_ID = "reef.browser";

interface StableChatRequest {
  readonly prompt: string;
}

interface StableChatResponseStream {
  progress(value: string): void;
  markdown(value: string): void;
}

interface StableChatParticipant extends vscode.Disposable {
  iconPath?: vscode.IconPath | vscode.ThemeIcon;
}

interface StableChatApi {
  createChatParticipant(
    id: string,
    handler: (
      request: StableChatRequest,
      context: unknown,
      stream: StableChatResponseStream,
      token: vscode.CancellationToken,
    ) => vscode.ProviderResult<unknown>,
  ): StableChatParticipant;
}

interface RunTaskResult {
  readonly sessionId?: string;
  readonly verify?: VerifyResult;
  readonly error?: string;
}

interface ChatTurnRecord {
  readonly turnId: string;
  readonly conversationId: string;
  readonly turn: number;
  readonly task: string;
  readonly autopilot: boolean;
  sessionId?: string;
  sessionDir?: string;
  status: "running" | "sealed" | "error";
  events: SessionEvent[];
  verify?: VerifyResult;
}

interface FocusRunRecord {
  readonly id: string;
  readonly task: string;
  readonly status: "running" | "sealed";
  readonly verifyOk?: boolean;
  readonly at: string;
}

interface WebviewMessage {
  readonly kind?: string;
  readonly task?: string;
  readonly turnId?: string;
  readonly conversationId?: string;
  readonly turn?: number;
  readonly autopilot?: boolean;
  readonly id?: string;
  readonly input?: Record<string, unknown>;
  readonly mode?: string;
  readonly title?: string;
  readonly tasks?: readonly string[];
  readonly specId?: string;
  readonly itemId?: string;
  readonly to?: string;
  readonly reason?: string;
  readonly activeIds?: readonly string[];
  readonly action?: string;
  readonly url?: string;
  readonly selector?: string;
  readonly note?: string;
  readonly tier?: string;
  readonly bbox?: {
    readonly x?: number;
    readonly y?: number;
    readonly width?: number;
    readonly height?: number;
    readonly viewportWidth?: number;
    readonly viewportHeight?: number;
  };
}

class ReefTextSurface
  implements ReefSurface, vscode.TextDocumentContentProvider
{
  private readonly uri = vscode.Uri.from({
    scheme: "reef-session",
    path: "/Reef Session",
  });
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private task = "idle";
  private rows: string[] = [];
  private verification = "Reef session pending";
  private checks = "";
  private chains = "";

  readonly onDidChange = this.changed.event;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        "reef-session",
        this,
      ),
      this.changed,
    );
  }

  provideTextDocumentContent(): string {
    return [
      "Reef Session",
      `Task: ${this.task}`,
      "",
      this.verification,
      this.checks,
      this.chains,
      "",
      "Evidence timeline",
      ...this.rows,
      "",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  async reveal(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(this.uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
  }

  reset(task: string): void {
    this.task = task;
    this.rows = [];
    this.verification = "Reef session running";
    this.checks = "";
    this.chains = "";
    this.fire();
  }

  event(event: SessionEvent): void {
    const evidence = event.evidenceId?.slice(0, 10) ?? "";
    this.rows.push(
      `${String(event.seq).padStart(2, "0")} ${event.kind} ${event.summary} ${evidence}`.trim(),
    );
    this.fire();
  }

  sealed(event: SealedEvent): void {
    this.applyVerification(event.verify);
    this.chains = `${event.snapshot.workChainLength} work links, ${event.snapshot.logChainLength} evidence links, ${event.snapshot.actionsExecuted} executed, ${event.snapshot.actionsDenied} denied`;
    this.fire();
  }

  verified(verify: VerifyResult): void {
    this.applyVerification(verify);
    this.fire();
  }

  error(message: string): void {
    this.verification = `Reef ✗ ${message}`;
    this.checks = "";
    this.fire();
  }

  private applyVerification(verify: VerifyResult): void {
    this.verification = verify.ok
      ? "Reef ✓ session verified"
      : `Reef ✗ UNVERIFIED — work ${verify.work}, log ${verify.log}, binding ${verify.binding}`;
    this.checks = `work ${verify.work}, log ${verify.log}, binding ${verify.binding}`;
  }

  private fire(): void {
    this.changed.fire(this.uri);
  }
}

function serverUrl(): string {
  return vscode.workspace
    .getConfiguration("reef")
    .get<string>("serverUrl", "http://127.0.0.1:4300");
}

function useBundledServer(): boolean {
  return vscode.workspace
    .getConfiguration("reef")
    .get<boolean>("useBundledServer", true);
}

function welcomeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("reef")
    .get<boolean>("welcome.enabled", true);
}

function updateRepository(): string {
  const repository = vscode.workspace
    .getConfiguration("reef")
    .get<string>("updateRepository", "octoryn/octopus-reef-editor")
    .trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`invalid GitHub repository: ${repository}`);
  }
  return repository;
}

function firstWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => candidate.uri.scheme === "file",
  );
  return folder?.uri.fsPath;
}

function priorityModelTierSetting(): PriorityModelTier {
  return vscode.workspace
    .getConfiguration("reef")
    .get<string>("priority.modelTier", "standard")
    .trim() === "priority"
    ? "priority"
    : "standard";
}

function isCommercialEdition(): boolean {
  return (reefEdition as string) === "commercial";
}

function modelSettings():
  | {
      readonly provider?: string;
      readonly apiKey?: string;
      readonly name?: string;
      readonly licenseToken?: string;
      readonly gatewayUrl?: string;
      readonly priorityTier?: PriorityModelTier;
    }
  | undefined {
  const config = vscode.workspace.getConfiguration("reef");
  const provider = config.get<string>("model.provider", "auto").trim();
  const apiKey = config.get<string>("model.apiKey", "").trim();
  const name = config.get<string>("model.name", "").trim();
  const priorityTier = priorityModelTierSetting();
  const licenseToken = config.get<string>("gateway.licenseToken", "").trim();
  const gatewayUrl = config.get<string>("gateway.url", "").trim();
  const model = {
    ...(provider !== "" ? { provider } : {}),
    ...(apiKey !== "" ? { apiKey } : {}),
    ...(name !== "" ? { name } : {}),
    priorityTier,
    ...(licenseToken !== "" ? { licenseToken } : {}),
    ...(gatewayUrl !== "" ? { gatewayUrl } : {}),
  };
  return Object.keys(model).length > 0 ? model : undefined;
}

function configuredAccountQuery(): AccountQuery {
  const config = vscode.workspace.getConfiguration("reef");
  const provider = config.get<string>("model.provider", "auto").trim();
  const apiKey = config.get<string>("model.apiKey", "").trim();
  const name = config.get<string>("model.name", "").trim();
  const gatewayUrl = config.get<string>("gateway.url", "").trim();
  const ssoUrl = config.get<string>("account.ssoUrl", "").trim();
  const priorityTier = priorityModelTierSetting();
  const hasAnthropic =
    apiKey !== "" || (process.env.ANTHROPIC_API_KEY ?? "").trim() !== "";
  const hasBedrock =
    apiKey !== "" ||
    (process.env.AWS_BEARER_TOKEN_BEDROCK ?? "").trim() !== "" ||
    (process.env.BEDROCK_API_KEY ?? "").trim() !== "";

  if (provider === "gateway") {
    return {
      provider: "gateway",
      model: name !== "" ? name : "reef-gateway-stub",
      source: "Reef settings: hosted gateway",
      priorityTier,
      ...(gatewayUrl !== "" ? { gatewayUrl } : {}),
      ...(ssoUrl !== "" ? { ssoUrl } : {}),
    };
  }
  if (provider === "anthropic" || (provider === "auto" && hasAnthropic)) {
    return {
      provider: "anthropic",
      model: name !== "" ? name : "Claude Sonnet 4.5",
      source: "Reef settings: BYOK Anthropic",
      priorityTier,
      ...(ssoUrl !== "" ? { ssoUrl } : {}),
    };
  }
  if (provider === "bedrock" || (provider === "auto" && hasBedrock)) {
    return {
      provider: "bedrock",
      model: name !== "" ? name : "Claude Sonnet 4.5",
      source: "Reef settings: BYOK Bedrock",
      priorityTier,
      ...(ssoUrl !== "" ? { ssoUrl } : {}),
    };
  }
  return {
    provider: "mock",
    model: "offline-mock",
    source: "Reef offline MockDriver",
    priorityTier,
    ...(ssoUrl !== "" ? { ssoUrl } : {}),
  };
}

async function currentProductVersion(
  context: vscode.ExtensionContext,
): Promise<string> {
  const candidates = [
    join(context.extensionUri.fsPath, "..", "..", "product.json"),
    join(context.extensionUri.fsPath, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(await readFile(candidate, "utf8")) as {
        version?: unknown;
      };
      if (typeof obj.version === "string" && obj.version.trim() !== "") {
        return obj.version;
      }
    } catch {
      /* Web extension hosts may not expose the packaged product files. */
    }
  }
  return vscode.version;
}

function normalizeReleaseVersion(tag: string): string {
  const cleaned = tag
    .replace(/^refs\/tags\//, "")
    .replace(/^reef[-_]?/i, "")
    .replace(/^v/i, "");
  return cleaned.match(/\d+(?:\.\d+){1,3}/)?.[0] ?? cleaned;
}

function compareReleaseVersions(left: string, right: string): number {
  const a = normalizeReleaseVersion(left)
    .split(".")
    .map((part) => Number(part));
  const b = normalizeReleaseVersion(right)
    .split(".")
    .map((part) => Number(part));
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const ai = a[i];
    const bi = b[i];
    const x = typeof ai === "number" && Number.isFinite(ai) ? ai : 0;
    const y = typeof bi === "number" && Number.isFinite(bi) ? bi : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function latestGitHubRelease(repository: string): Promise<GitHubRelease> {
  const res = await fetch(
    `https://api.github.com/repos/${repository}/releases/latest`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `Reef/${vscode.version}`,
      },
    },
  );
  if (res.status === 404) {
    throw new Error(`no published GitHub release found for ${repository}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub Releases returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as GitHubRelease;
}

function setStatus(
  item: vscode.StatusBarItem,
  verify: VerifyResult | undefined,
  fallback = "Reef session running",
): void {
  item.command = "reef.verifySession";
  if (verify === undefined) {
    item.text = fallback;
    item.tooltip = "Reef governed session";
    item.backgroundColor = undefined;
    item.show();
    return;
  }

  if (verify.ok) {
    item.text = "Reef ✓ session verified";
    item.tooltip = `work ${verify.work}, log ${verify.log}, binding ${verify.binding}`;
    item.backgroundColor = undefined;
  } else {
    item.text = "Reef ✗ UNVERIFIED";
    item.tooltip = `work ${verify.work}, log ${verify.log}, binding ${verify.binding}`;
    item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
  }
  item.show();
}

function setSpecStatus(
  item: vscode.StatusBarItem,
  verify: { readonly ok: boolean; readonly work: string } | undefined,
): void {
  item.command = "reef.verifySession";
  if (verify === undefined) {
    item.text = "Reef spec pending";
    item.tooltip = "Reef governed spec";
    item.backgroundColor = undefined;
    item.show();
    return;
  }
  if (verify.ok) {
    item.text = "Reef ✓ spec verified";
    item.tooltip = `workstate ${verify.work}`;
    item.backgroundColor = undefined;
  } else {
    item.text = "Reef ✗ SPEC UNVERIFIED";
    item.tooltip = `workstate ${verify.work}`;
    item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
  }
  item.show();
}

async function waitForBundledServer(
  context: vscode.ExtensionContext,
  persistDir: string,
): Promise<{ url: string; process: ChildProcess }> {
  await mkdir(persistDir, { recursive: true });
  const serverPath = context.asAbsolutePath("server/reef-server.cjs");
  const workspaceRoot = firstWorkspaceRoot();
  const model = modelSettings();
  const child = spawn(
    process.execPath,
    [serverPath, "--port", "0", "--host", "127.0.0.1", "--persist", persistDir],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        REEF_BUNDLED_DAEMON: "1",
        REEF_EDITION: reefEdition,
        ...(workspaceRoot !== undefined
          ? { REEF_WORKSPACE_ROOT: workspaceRoot }
          : {}),
        ...(model?.provider !== undefined
          ? { REEF_MODEL_PROVIDER: model.provider }
          : {}),
        ...(model?.apiKey !== undefined
          ? { REEF_MODEL_API_KEY: model.apiKey }
          : {}),
        ...(model?.name !== undefined ? { REEF_MODEL_NAME: model.name } : {}),
        ...(model?.priorityTier !== undefined
          ? { REEF_PRIORITY_MODEL_TIER: model.priorityTier }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (child.stdout === null || child.stderr === null) {
    child.kill();
    throw new Error("bundled daemon did not expose stdout/stderr");
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`bundled daemon did not start: ${stderr || stdout}`));
    }, 15_000);
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve({ url: match[1], process: child });
      }
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `bundled daemon exited before ready: code=${String(code)} signal=${String(signal)} ${stderr}`,
        ),
      );
    });
  });
}

export function activate(context: vscode.ExtensionContext): void {
  let sessionView: vscode.WebviewView | undefined;
  let welcomePanel: vscode.WebviewPanel | undefined;
  let agentFocusPanel: vscode.WebviewPanel | undefined;
  let powersView: vscode.WebviewView | undefined;
  let managerView: vscode.WebviewView | undefined;
  let hooksView: vscode.WebviewView | undefined;
  let browserView: vscode.WebviewView | undefined;
  let specsView: vscode.WebviewView | undefined;
  let accountView: vscode.WebviewView | undefined;
  let steeringView: vscode.WebviewView | undefined;
  let usageView: vscode.WebviewView | undefined;
  let textSurface: ReefTextSurface | undefined;
  let abort: AbortController | undefined;
  let focusAbort: AbortController | undefined;
  let lastVerify: ServerEvent | undefined;
  let lastSessionId: string | undefined;
  let lastSessionDir: string | undefined;
  let activeManagerFleetId: string | undefined;
  let focusSessionId: string | undefined;
  let focusSessionTask = "";
  let focusEvents: SessionEvent[] = [];
  let focusVerify: VerifyResult | undefined;
  let focusRuns: FocusRunRecord[] = [];
  let focusWindowMode: "ide" | "focus" = "ide";
  let focusRun: Promise<RunTaskResult> | undefined;
  let chatRun: Promise<RunTaskResult> | undefined;
  let chatConversationId = `reef-chat-${Date.now().toString(36)}`;
  const chatTurns = new Map<string, ChatTurnRecord>();
  let activeSpecId: string | undefined;
  let activeServerUrl = serverUrl();
  let daemon: ChildProcess | undefined;
  let demoStarted = false;
  let webviewRun: Promise<RunTaskResult> | undefined;
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  const accountStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99,
  );
  setStatus(status, undefined, "Reef idle");
  accountStatus.text = "Reef Account";
  accountStatus.tooltip = "Open Reef Account & Plan";
  accountStatus.command = "reef.openAccount";
  accountStatus.show();

  const revealView = async (
    viewId: string,
    view: vscode.WebviewView | undefined,
  ): Promise<void> => {
    if (view !== undefined) {
      view.show(false);
      return;
    }
    await vscode.commands.executeCommand(`${viewId}.focus`);
  };

  const setViewHtml = (
    view: vscode.WebviewView,
    scriptFile: string,
    html: (cspSource: string, scriptUri: string) => string,
  ): void => {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
    };
    view.webview.html = html(
      view.webview.cspSource,
      view.webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, scriptFile))
        .toString(),
    );
  };

  const sessionWebview = (): vscode.Webview | undefined => sessionView?.webview;

  const webviewSurface = (): ReefSurface => ({
    reveal: () => revealView(REEF_SESSION_VIEW_ID, sessionView),
    reset: (task) =>
      void sessionWebview()?.postMessage({ kind: "reset", task }),
    event: (event) =>
      void sessionWebview()?.postMessage({ kind: "event", event }),
    sealed: (event) =>
      void sessionWebview()?.postMessage({
        kind: "sealed",
        snapshot: event.snapshot,
        verify: event.verify,
      }),
    verified: (verify) =>
      void sessionWebview()?.postMessage({ kind: "verified", verify }),
    error: (message) =>
      void sessionWebview()?.postMessage({ kind: "error", message }),
  });

  const ensureSurface = (): ReefSurface => {
    if (vscode.env.uiKind === vscode.UIKind.Web) {
      textSurface ??= new ReefTextSurface(context);
      return textSurface;
    }
    return webviewSurface();
  };

  const persistDir = join(context.globalStorageUri.fsPath, "sessions");
  const writeState = async (): Promise<void> => {
    await mkdir(context.globalStorageUri.fsPath, { recursive: true });
    await writeFile(
      join(context.globalStorageUri.fsPath, "last-session.json"),
      JSON.stringify(
        {
          serverUrl: activeServerUrl,
          sessionId: lastSessionId ?? null,
          sessionDir: lastSessionDir ?? null,
          persistDir,
          verify: lastVerify?.type === "sealed" ? lastVerify.verify : null,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  };

  const writeChatState = async (): Promise<void> => {
    await mkdir(context.globalStorageUri.fsPath, { recursive: true });
    await writeFile(
      join(context.globalStorageUri.fsPath, "last-chat.json"),
      JSON.stringify(
        {
          serverUrl: activeServerUrl,
          conversationId: chatConversationId,
          turns: [...chatTurns.values()].map((turn) => ({
            turnId: turn.turnId,
            conversationId: turn.conversationId,
            turn: turn.turn,
            task: turn.task,
            autopilot: turn.autopilot,
            sessionId: turn.sessionId ?? null,
            sessionDir: turn.sessionDir ?? null,
            status: turn.status,
            verify: turn.verify ?? null,
            evidenceLinks: turn.events.length,
          })),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  };

  const chatView = (
    turn: ChatTurnRecord,
    usage?: Awaited<ReturnType<typeof getUsage>>,
  ): FocusRunView =>
    buildFocusRunView({
      task: turn.task,
      events: turn.events,
      ...(turn.verify !== undefined ? { verify: turn.verify } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
    });

  const postChatConfig = async (): Promise<void> => {
    const usage = await getUsage(activeServerUrl).catch(() => undefined);
    const tasks = await collectChatTasks().catch(() => []);
    void sessionWebview()?.postMessage({
      kind: "chatConfig",
      conversationId: chatConversationId,
      modelChip: chatModelChip(modelSettings(), process.env),
      usage: focusUsageSnapshot(usage, lastSessionId),
      commands: CHAT_COMMANDS,
      routes: CHAT_ROUTES,
      tasks,
    });
  };

  const collectChatTasks = async (): Promise<ChatTaskCandidate[]> => {
    const listed = await listSpecs(activeServerUrl);
    const specs = (
      await Promise.all(
        listed.specs.map((spec) =>
          getSpec(activeServerUrl, spec.id).catch(() => undefined),
        ),
      )
    ).filter((spec): spec is Awaited<ReturnType<typeof getSpec>> => {
      return spec !== undefined;
    });
    return openTaskCandidates(specs);
  };

  const postChatUsage = async (): Promise<void> => {
    const usage = await getUsage(activeServerUrl);
    void sessionWebview()?.postMessage({
      kind: "chatUsage",
      usage: focusUsageSnapshot(usage, lastSessionId),
    });
  };

  const startNewChatSession = async (): Promise<void> => {
    abort?.abort();
    chatConversationId = `reef-chat-${Date.now().toString(36)}`;
    chatTurns.clear();
    lastVerify = undefined;
    lastSessionId = undefined;
    lastSessionDir = undefined;
    await writeState();
    await writeChatState();
    void sessionWebview()?.postMessage({
      kind: "chatSessionReset",
      conversationId: chatConversationId,
    });
    await postChatConfig();
    setStatus(status, undefined, "Reef ready for a new chat session");
  };

  const postChatError = (message: string, turnId?: string): void => {
    void sessionWebview()?.postMessage({
      kind: "chatError",
      message,
      ...(turnId !== undefined ? { turnId } : {}),
    });
  };

  const verifyChatTurn = async (
    turnId: string,
  ): Promise<VerifyResult | undefined> => {
    const turn = chatTurns.get(turnId);
    if (turn?.sessionId === undefined) {
      postChatError(
        "Reef: this chat turn has not sealed a session yet.",
        turnId,
      );
      return undefined;
    }
    const v = await verifySession(activeServerUrl, turn.sessionId);
    turn.verify = v;
    if (
      lastSessionId === turn.sessionId &&
      lastVerify !== undefined &&
      lastVerify.type === "sealed"
    ) {
      lastVerify = {
        type: "sealed",
        snapshot: lastVerify.snapshot,
        verify: v,
      };
      await writeState();
    }
    await writeChatState();
    const usage = await getUsage(activeServerUrl).catch(() => undefined);
    void sessionWebview()?.postMessage({
      kind: "chatTurnVerified",
      turnId,
      verify: v,
      view: chatView(turn, usage),
    });
    setStatus(status, v);
    return v;
  };

  const runTask = async (
    task: string,
    extra: {
      readonly mcp?: {
        readonly serverId?: string;
        readonly tool?: string;
        readonly input?: unknown;
        readonly expectDenied?: boolean;
      };
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
      readonly spec?: {
        readonly specId?: string;
        readonly itemId?: string;
        readonly to?: WorkState;
        readonly reason?: string;
      };
      readonly account?: AccountQuery;
      readonly persist?: boolean;
    } = {},
  ): Promise<RunTaskResult> => {
    const base = activeServerUrl;
    const workspaceRoot = firstWorkspaceRoot();
    const model = modelSettings();
    const surface = ensureSurface();
    await surface.reveal();
    surface.reset(task);
    abort?.abort();
    abort = new AbortController();
    lastVerify = undefined;
    lastSessionId = undefined;
    lastSessionDir = undefined;
    let runVerify: VerifyResult | undefined;
    setStatus(status, undefined);

    try {
      const id = await createSession(base, task.trim(), {
        persist: extra.persist !== false,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(extra.mcp !== undefined ? { mcp: extra.mcp } : {}),
        ...(extra.browser !== undefined ? { browser: extra.browser } : {}),
        ...(extra.spec !== undefined ? { spec: extra.spec } : {}),
        ...(extra.account !== undefined ? { account: extra.account } : {}),
      });
      lastSessionId = id;
      lastSessionDir = join(persistDir, id);
      await writeState();
      await streamEvents(
        base,
        id,
        (event) => {
          if (event.type === "event") {
            surface.event(event.event);
          } else if (event.type === "sealed") {
            lastVerify = event;
            runVerify = event.verify;
            surface.sealed(event);
            setStatus(status, event.verify);
            void writeState();
          }
        },
        abort.signal,
      );
      return {
        sessionId: id,
        ...(runVerify !== undefined ? { verify: runVerify } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      surface.error(message);
      status.text = "Reef ✗ session failed";
      status.tooltip = message;
      status.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
      status.show();
      void vscode.window.showErrorMessage(
        `Reef: could not reach the daemon at ${base} — is \`reef serve\` running? (${message})`,
      );
      return { error: message };
    }
  };

  const runChatTurn = async (input: {
    readonly task: string;
    readonly turnId: string;
    readonly conversationId: string;
    readonly turn: number;
    readonly autopilot: boolean;
  }): Promise<RunTaskResult> => {
    const base = activeServerUrl;
    const trimmed = input.task.trim();
    if (trimmed === "") return { error: "task is required" };
    const tasks = await collectChatTasks().catch(() => []);
    const resolved = resolveChatAffordances(trimmed, tasks);
    if (!resolved.ok) {
      postChatError(resolved.message, input.turnId);
      return { error: resolved.message };
    }
    const workspaceRoot = firstWorkspaceRoot();
    const model = modelSettings();
    chatConversationId = input.conversationId;
    const parentSessionId = [...chatTurns.values()]
      .filter((turn) => turn.sessionId !== undefined)
      .sort((a, b) => b.turn - a.turn)[0]?.sessionId;
    const verifyTargetTurnId =
      resolved.affordances.command?.id === "verify"
        ? [...chatTurns.values()]
            .filter((turn) => turn.sessionId !== undefined)
            .sort((a, b) => b.turn - a.turn)[0]?.turnId
        : undefined;
    const conversation: ChatConversationContext = chatConversationContext({
      conversationId: input.conversationId,
      turn: input.turn,
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      autopilot: input.autopilot,
      ...(resolved.affordances.command !== undefined
        ? { command: resolved.affordances.command }
        : {}),
      ...(resolved.affordances.taskRef !== undefined
        ? { taskRef: resolved.affordances.taskRef }
        : {}),
      route: resolved.affordances.route,
    });
    const record: ChatTurnRecord = {
      turnId: input.turnId,
      conversationId: conversation.id,
      turn: conversation.turn,
      task: trimmed,
      autopilot: input.autopilot,
      status: "running",
      events: [],
    };
    chatTurns.set(input.turnId, record);
    await writeChatState();
    const surface = ensureSurface();
    await surface.reveal();
    abort?.abort();
    abort = new AbortController();
    lastVerify = undefined;
    lastSessionId = undefined;
    lastSessionDir = undefined;
    let runVerify: VerifyResult | undefined;
    setStatus(status, undefined, "Reef chat turn running");
    void sessionWebview()?.postMessage({
      kind: "chatTurnStarted",
      turnId: input.turnId,
      conversationId: conversation.id,
      turn: conversation.turn,
      approval: chatApprovalLabel(input.autopilot),
      modelChip: chatModelChip(model, process.env),
    });

    try {
      const id = await createSession(base, trimmed, {
        persist: true,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        ...(model !== undefined ? { model } : {}),
        conversation,
      });
      record.sessionId = id;
      record.sessionDir = join(persistDir, id);
      lastSessionId = id;
      lastSessionDir = record.sessionDir;
      await writeState();
      await writeChatState();
      void sessionWebview()?.postMessage({
        kind: "chatTurnSession",
        turnId: input.turnId,
        sessionId: id,
        sessionDir: record.sessionDir,
      });
      await streamEvents(
        base,
        id,
        (event) => {
          if (event.type === "event") {
            record.events.push(event.event);
            void sessionWebview()?.postMessage({
              kind: "chatTurnEvent",
              turnId: input.turnId,
              event: event.event,
              view: chatView(record),
            });
          } else if (event.type === "sealed") {
            lastVerify = event;
            runVerify = event.verify;
            record.status = "sealed";
            record.verify = event.verify;
            setStatus(status, event.verify);
            void writeState();
            void writeChatState();
            void sessionWebview()?.postMessage({
              kind: "chatTurnSealed",
              turnId: input.turnId,
              snapshot: event.snapshot,
              verify: event.verify,
              view: chatView(record),
            });
            void postChatUsage().catch((err) => {
              postChatError(err instanceof Error ? err.message : String(err));
            });
          }
        },
        abort.signal,
      );
      if (verifyTargetTurnId !== undefined) {
        await verifyChatTurn(verifyTargetTurnId);
      }
      return {
        sessionId: id,
        ...(runVerify !== undefined ? { verify: runVerify } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.status = "error";
      await writeChatState();
      postChatError(message, input.turnId);
      status.text = "Reef ✗ chat turn failed";
      status.tooltip = message;
      status.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
      status.show();
      return { error: message };
    }
  };

  const rememberFocusRun = (
    id: string,
    task: string,
    update: Partial<Omit<FocusRunRecord, "id" | "task" | "at">> = {},
  ): void => {
    const existing = focusRuns.find((run) => run.id === id);
    const record: FocusRunRecord = {
      id,
      task,
      at: existing?.at ?? new Date().toISOString(),
      status: update.status ?? existing?.status ?? "running",
      ...(update.verifyOk !== undefined
        ? { verifyOk: update.verifyOk }
        : existing?.verifyOk !== undefined
          ? { verifyOk: existing.verifyOk }
          : {}),
    };
    focusRuns = [
      record,
      ...focusRuns.filter((candidate) => candidate.id !== id),
    ].slice(0, 12);
  };

  const currentFocusView = (
    usage?: Awaited<ReturnType<typeof getUsage>>,
  ): FocusRunView =>
    buildFocusRunView({
      task: focusSessionTask || "No focus task yet.",
      events: focusEvents,
      ...(focusVerify !== undefined ? { verify: focusVerify } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(focusSessionId !== undefined ? { sessionId: focusSessionId } : {}),
    });

  const postFocusState = (view?: FocusRunView): void => {
    void agentFocusPanel?.webview.postMessage({
      kind: "focusState",
      sessions: focusRuns,
      currentSessionId: focusSessionId ?? "",
      windowMode: focusWindowMode,
      ...(view !== undefined ? { view } : {}),
    });
  };

  const postFocusUsage = async (): Promise<void> => {
    const usage = await getUsage(activeServerUrl);
    void agentFocusPanel?.webview.postMessage({
      kind: "focusUsage",
      usage: focusUsageSnapshot(usage, focusSessionId),
    });
    postFocusState(currentFocusView(usage));
  };

  const postFocusError = (message: string): void => {
    void agentFocusPanel?.webview.postMessage({
      kind: "focusError",
      message,
    });
  };

  const moveAgentFocus = async (mode: "focus" | "ide"): Promise<void> => {
    if (agentFocusPanel === undefined) return;
    agentFocusPanel.reveal(vscode.ViewColumn.Active);
    const command =
      mode === "focus"
        ? "workbench.action.moveEditorToNewWindow"
        : "workbench.action.restoreEditorsToMainWindow";
    try {
      await vscode.commands.executeCommand(command);
      focusWindowMode = mode;
      void agentFocusPanel.webview.postMessage({
        kind: "focusWindow",
        mode,
        tone: "ok",
        message:
          mode === "focus"
            ? "Agent Focus moved to a separate window."
            : "Agent Focus restored to the IDE window.",
      });
    } catch (err) {
      if (mode === "ide") {
        try {
          await vscode.commands.executeCommand(
            "workbench.action.switchToMainWindow",
          );
        } catch {
          /* keep the original restore failure below */
        }
      }
      focusWindowMode = mode === "focus" ? "ide" : "ide";
      void agentFocusPanel.webview.postMessage({
        kind: "focusWindow",
        mode: focusWindowMode,
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const verifyFocusSession = async (
    showMessage = false,
  ): Promise<VerifyResult | undefined> => {
    if (focusSessionId === undefined) {
      const message = "Reef: run an Agent Focus task first, then verify it.";
      postFocusError(message);
      if (showMessage) void vscode.window.showInformationMessage(message);
      return undefined;
    }
    const v = await verifySession(activeServerUrl, focusSessionId);
    focusVerify = v;
    rememberFocusRun(focusSessionId, focusSessionTask, {
      status: "sealed",
      verifyOk: v.ok,
    });
    if (
      lastSessionId === focusSessionId &&
      lastVerify !== undefined &&
      lastVerify.type === "sealed"
    ) {
      lastVerify = {
        type: "sealed",
        snapshot: lastVerify.snapshot,
        verify: v,
      };
      await writeState();
    }
    const usage = await getUsage(activeServerUrl).catch(() => undefined);
    void agentFocusPanel?.webview.postMessage({
      kind: "focusVerified",
      sessions: focusRuns,
      view: currentFocusView(usage),
    });
    setStatus(status, v);
    if (showMessage) {
      void vscode.window.showInformationMessage(
        v.ok
          ? `Reef Agent Focus ✓ VERIFIED — work ${v.work}, log ${v.log}, binding ${v.binding}`
          : `Reef Agent Focus ✗ UNVERIFIED — work ${v.work}, log ${v.log}, binding ${v.binding}`,
      );
    }
    return v;
  };

  const runFocusTask = async (task: string): Promise<RunTaskResult> => {
    const base = activeServerUrl;
    const trimmed = task.trim();
    if (trimmed === "") return { error: "task is required" };
    const workspaceRoot = firstWorkspaceRoot();
    const model = modelSettings();
    agentFocusPanel?.reveal(vscode.ViewColumn.Active);
    focusAbort?.abort();
    focusAbort = new AbortController();
    focusSessionId = undefined;
    focusSessionTask = trimmed;
    focusEvents = [];
    focusVerify = undefined;
    lastVerify = undefined;
    lastSessionId = undefined;
    lastSessionDir = undefined;
    setStatus(status, undefined, "Reef Agent Focus running");
    void agentFocusPanel?.webview.postMessage({
      kind: "focusReset",
      task: trimmed,
    });

    try {
      const id = await createSession(base, trimmed, {
        persist: true,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      focusSessionId = id;
      lastSessionId = id;
      lastSessionDir = join(persistDir, id);
      rememberFocusRun(id, trimmed);
      await writeState();
      void agentFocusPanel?.webview.postMessage({
        kind: "focusStarted",
        sessionId: id,
        sessions: focusRuns,
      });

      await streamEvents(
        base,
        id,
        (event) => {
          if (event.type === "event") {
            focusEvents.push(event.event);
            void agentFocusPanel?.webview.postMessage({
              kind: "focusEvent",
              event: buildFocusRunView({
                task: trimmed,
                events: [event.event],
              }).evidence[0],
              view: currentFocusView(),
            });
          } else if (event.type === "sealed") {
            lastVerify = event;
            focusVerify = event.verify;
            rememberFocusRun(id, trimmed, {
              status: "sealed",
              verifyOk: event.verify.ok,
            });
            setStatus(status, event.verify);
            void writeState();
            void agentFocusPanel?.webview.postMessage({
              kind: "focusSealed",
              sessions: focusRuns,
              view: currentFocusView(),
            });
            void postFocusUsage().catch((err) => {
              void agentFocusPanel?.webview.postMessage({
                kind: "focusUsage",
                usage: focusUsageSnapshot(undefined, undefined),
              });
              postFocusError(err instanceof Error ? err.message : String(err));
            });
          }
        },
        focusAbort.signal,
      );
      return {
        sessionId: id,
        ...(focusVerify !== undefined ? { verify: focusVerify } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      postFocusError(message);
      status.text = "Reef ✗ Agent Focus failed";
      status.tooltip = message;
      status.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
      status.show();
      void vscode.window.showErrorMessage(
        `Reef Agent Focus: could not run the governed session at ${base} (${message})`,
      );
      return { error: message };
    }
  };

  const runMcpDemo = async (mode: "allowed" | "denied"): Promise<void> => {
    const denied = mode === "denied";
    const task = denied
      ? "N5 MCP denial demo: unallowlisted reef-echo.reverse"
      : "N5 MCP demo: call reef-echo.echo offline";
    const result = await runTask(task, {
      mcp: {
        serverId: "reef-echo",
        tool: denied ? "reverse" : "echo",
        input: { text: "reef n5 offline" },
        expectDenied: denied,
      },
    });
    void powersView?.webview.postMessage({
      kind: "status",
      tone: result.error === undefined ? "ok" : "bad",
      message:
        result.error === undefined
          ? `Governed MCP ${mode} session sealed: ${result.sessionId ?? "unknown"}`
          : result.error,
    });
  };

  const runBrowserDemo = async (
    mode: "allowed" | "denied",
    url: string,
  ): Promise<void> => {
    const trimmed = url.trim();
    if (trimmed === "") {
      void browserView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: "Enter a local URL before running the browser Power.",
      });
      return;
    }
    const result = await runTask(
      mode === "allowed"
        ? `N11 browser governed read: ${trimmed}`
        : `N11 browser denial proof: ${trimmed}`,
      {
        browser:
          mode === "allowed"
            ? { url: trimmed }
            : {
                url: trimmed,
                tool: "browser.screenshot",
                expectDenied: true,
              },
      },
    );
    void browserView?.webview.postMessage({
      kind: "status",
      tone: result.error === undefined ? "ok" : "bad",
      message:
        result.error === undefined
          ? `Governed browser ${mode} session sealed: ${result.sessionId ?? "unknown"}`
          : result.error,
    });
  };

  const runBrowserAnnotation = async (
    url: string,
    note: string,
    bbox: NonNullable<WebviewMessage["bbox"]>,
  ): Promise<void> => {
    const trimmed = url.trim();
    if (trimmed === "") {
      void browserView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: "Enter a local URL before annotating.",
      });
      return;
    }
    const result = await runTask(`N11c browser annotation: ${note.trim()}`, {
      browser: {
        url: trimmed,
        annotation: {
          url: trimmed,
          note: note.trim() === "" ? "Annotated browser region" : note.trim(),
          bbox,
        },
      },
    });
    void browserView?.webview.postMessage({
      kind: "annotationSealed",
      tone: result.error === undefined ? "ok" : "bad",
      sessionId: result.sessionId,
      message:
        result.error === undefined
          ? `Annotation evidence sealed: ${result.sessionId ?? "unknown"}`
          : result.error,
    });
  };

  const configuredBrowserUrl = (): string =>
    vscode.workspace
      .getConfiguration("reef")
      .get("browser.url", "http://127.0.0.1:5173/")
      .trim();

  const refreshPowers = async (): Promise<void> => {
    const powers = await listPowers(activeServerUrl);
    void powersView?.webview.postMessage({ kind: "powers", powers });
  };

  const refreshSpecs = async (): Promise<void> => {
    const specs = await listSpecs(activeServerUrl);
    if (
      activeSpecId === undefined &&
      specs.specs.length > 0 &&
      specs.specs[0] !== undefined
    ) {
      activeSpecId = specs.specs[0].id;
    }
    void specsView?.webview.postMessage({ kind: "specs", specs });
    if (activeSpecId !== undefined) {
      const spec = await getSpec(activeServerUrl, activeSpecId);
      void specsView?.webview.postMessage({ kind: "spec", spec });
    }
  };

  const refreshAccount = async (): Promise<void> => {
    const account = await getAccount(activeServerUrl, configuredAccountQuery());
    void accountView?.webview.postMessage({ kind: "account", account });
  };

  const refreshUsage = async (): Promise<void> => {
    const usage = await getUsage(activeServerUrl);
    void usageView?.webview.postMessage({ kind: "usage", usage });
  };

  const refreshManager = async (): Promise<void> => {
    if (activeManagerFleetId === undefined) return;
    const fleet = await getManagerFleet(activeServerUrl, activeManagerFleetId);
    void managerView?.webview.postMessage({ kind: "managerFleet", fleet });
  };

  const refreshSteering = async (): Promise<void> => {
    const steering = await listSteering(activeServerUrl);
    void steeringView?.webview.postMessage({ kind: "steering", steering });
  };

  const refreshHooks = async (): Promise<void> => {
    const hooks = await listHooks(activeServerUrl);
    void hooksView?.webview.postMessage({ kind: "hooks", hooks });
  };

  const postWelcomeStatus = (message: string, tone = ""): void => {
    void welcomePanel?.webview.postMessage({
      kind: "welcomeStatus",
      message,
      tone,
    });
  };

  const executeWelcomeAction = async (action: WelcomeAction): Promise<void> => {
    const command = welcomeCommandForAction(action);
    try {
      await vscode.commands.executeCommand(command);
      postWelcomeStatus("Opened.", "ok");
    } catch (err) {
      if (action === "cloneConnect") {
        try {
          await vscode.commands.executeCommand("workbench.view.scm");
          postWelcomeStatus("Opened Source Control.", "ok");
          return;
        } catch {
          /* Report the original clone failure below. */
        }
      }
      postWelcomeStatus(
        err instanceof Error ? err.message : String(err),
        "bad",
      );
    }
  };

  const runSpecAdvance = async (
    specId: string,
    itemId: string,
    to: WorkState,
    reason?: string,
  ): Promise<void> => {
    activeSpecId = specId;
    const result = await runTask(`N2 spec transition: ${itemId} -> ${to}`, {
      spec: {
        specId,
        itemId,
        to,
        ...(reason !== undefined ? { reason } : {}),
      },
    });
    if (result.error !== undefined) {
      void specsView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: result.error,
      });
      return;
    }
    await refreshSpecs();
    void specsView?.webview.postMessage({
      kind: "status",
      tone: "ok",
      message: `Governed spec transition sealed: ${result.sessionId ?? "unknown"}`,
    });
  };

  const openAgentFocusPanel = (): void => {
    if (agentFocusPanel === undefined) {
      agentFocusPanel = vscode.window.createWebviewPanel(
        "reef.agentFocus",
        "Reef Agent Focus",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      agentFocusPanel.webview.html = agentFocusWebviewHtml(
        agentFocusPanel.webview.cspSource,
        agentFocusPanel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(
              context.extensionUri,
              "media",
              "agent-focus.js",
            ),
          )
          .toString(),
      );
      agentFocusPanel.onDidDispose(() => {
        agentFocusPanel = undefined;
        focusAbort?.abort();
      });
      agentFocusPanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void (async () => {
          try {
            if (message.kind === "agentFocusReady") {
              postFocusState(currentFocusView());
              await postFocusUsage().catch(() => undefined);
            } else if (
              message.kind === "runFocusTask" &&
              typeof message.task === "string" &&
              message.task.trim() !== ""
            ) {
              if (focusRun !== undefined) return;
              focusRun = runFocusTask(message.task).finally(() => {
                focusRun = undefined;
              });
              await focusRun;
            } else if (message.kind === "focusToWindow") {
              await moveAgentFocus("focus");
            } else if (message.kind === "focusToIde") {
              await moveAgentFocus("ide");
            } else if (message.kind === "verifyFocus") {
              await verifyFocusSession();
            } else if (message.kind === "refreshFocusUsage") {
              await postFocusUsage();
            }
          } catch (err) {
            postFocusError(err instanceof Error ? err.message : String(err));
          }
        })();
      });
    }
    agentFocusPanel.reveal(vscode.ViewColumn.Active);
    postFocusState(currentFocusView());
  };

  const openWelcomePanel = (): void => {
    if (welcomePanel === undefined) {
      welcomePanel = vscode.window.createWebviewPanel(
        "reef.welcome",
        "Reef Welcome",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      welcomePanel.webview.html = welcomeWebviewHtml(
        welcomePanel.webview.cspSource,
        welcomePanel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, "media", "welcome.js"),
          )
          .toString(),
      );
      welcomePanel.onDidDispose(() => {
        welcomePanel = undefined;
      });
      welcomePanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void (async () => {
          try {
            if (
              message.kind === "welcomeAction" &&
              isWelcomeAction(message.action)
            ) {
              await executeWelcomeAction(message.action);
            } else if (message.kind === "disableWelcome") {
              await vscode.workspace
                .getConfiguration("reef")
                .update(
                  "welcome.enabled",
                  false,
                  vscode.ConfigurationTarget.Global,
                );
              postWelcomeStatus("Welcome disabled for future launches.", "ok");
            }
          } catch (err) {
            postWelcomeStatus(
              err instanceof Error ? err.message : String(err),
              "bad",
            );
          }
        })();
      });
    }
    welcomePanel.reveal(vscode.ViewColumn.Active);
  };

  const handleSessionMessage = async (
    message: WebviewMessage,
  ): Promise<void> => {
    if (message.kind === "chatReady") {
      await postChatConfig();
      return;
    }
    if (message.kind === "openAgentFocus") {
      openAgentFocusPanel();
      await moveAgentFocus("focus");
      return;
    }
    if (message.kind === "newSession") {
      await startNewChatSession();
      return;
    }
    if (message.kind === "showSessionMenu") {
      void sessionWebview()?.postMessage({ kind: "sessionMenu", open: true });
      return;
    }
    if (
      message.kind === "sendChatTurn" &&
      typeof message.task === "string" &&
      typeof message.turnId === "string" &&
      message.task.trim() !== ""
    ) {
      if (chatRun !== undefined) return;
      chatRun = runChatTurn({
        task: message.task,
        turnId: message.turnId,
        conversationId:
          typeof message.conversationId === "string"
            ? message.conversationId
            : chatConversationId,
        turn:
          typeof message.turn === "number" && message.turn > 0
            ? message.turn
            : chatTurns.size + 1,
        autopilot: message.autopilot === true,
      }).finally(() => {
        chatRun = undefined;
      });
      await chatRun;
      return;
    }
    if (
      message.kind === "verifyChatTurn" &&
      typeof message.turnId === "string"
    ) {
      await verifyChatTurn(message.turnId);
      return;
    }
    if (message.kind === "refreshChatUsage") {
      await postChatUsage();
      return;
    }
    if (
      message.kind === "runTask" &&
      typeof message.task === "string" &&
      message.task.trim() !== ""
    ) {
      if (webviewRun !== undefined) return;
      webviewRun = runTask(message.task).finally(() => {
        webviewRun = undefined;
      });
      await webviewRun;
    }
  };

  const handlePowersMessage = async (
    message: WebviewMessage,
  ): Promise<void> => {
    try {
      if (message.kind === "listPowers") {
        await refreshPowers();
      } else if (
        message.kind === "installPower" &&
        typeof message.id === "string"
      ) {
        await installPower(activeServerUrl, message.id);
        await refreshPowers();
      } else if (
        message.kind === "addCustomPower" &&
        message.input !== undefined
      ) {
        await addCustomPower(activeServerUrl, message.input);
        await refreshPowers();
      } else if (message.kind === "runMcpDemo") {
        await runMcpDemo(message.mode === "denied" ? "denied" : "allowed");
      }
    } catch (err) {
      void powersView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSpecsMessage = async (message: WebviewMessage): Promise<void> => {
    try {
      if (message.kind === "listSpecs") {
        await refreshSpecs();
      } else if (message.kind === "createSpec") {
        const spec = await createSpec(activeServerUrl, {
          ...(typeof message.title === "string" && message.title.trim() !== ""
            ? { title: message.title.trim() }
            : {}),
          ...(Array.isArray(message.tasks) ? { tasks: message.tasks } : {}),
        });
        activeSpecId = spec.id;
        await refreshSpecs();
        void specsView?.webview.postMessage({
          kind: "status",
          tone: "ok",
          message: `Created spec ${spec.id}`,
        });
      } else if (
        message.kind === "selectSpec" &&
        typeof message.id === "string"
      ) {
        activeSpecId = message.id;
        const spec = await getSpec(activeServerUrl, activeSpecId);
        void specsView?.webview.postMessage({ kind: "spec", spec });
        await refreshSpecs();
      } else if (
        message.kind === "advanceSpec" &&
        typeof message.specId === "string" &&
        typeof message.itemId === "string" &&
        typeof message.to === "string"
      ) {
        await runSpecAdvance(
          message.specId,
          message.itemId,
          message.to as WorkState,
          message.reason,
        );
      } else if (
        message.kind === "illegalSpecTransition" &&
        typeof message.specId === "string" &&
        typeof message.itemId === "string" &&
        typeof message.to === "string"
      ) {
        try {
          await advanceSpec(activeServerUrl, message.specId, {
            itemId: message.itemId,
            to: message.to as WorkState,
            ...(message.reason !== undefined ? { reason: message.reason } : {}),
          });
          void specsView?.webview.postMessage({
            kind: "status",
            tone: "bad",
            message: "Illegal transition unexpectedly succeeded.",
          });
        } catch (err) {
          void specsView?.webview.postMessage({
            kind: "status",
            tone: "bad",
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          activeSpecId = message.specId;
          await refreshSpecs();
        }
      } else if (
        message.kind === "verifySpec" &&
        typeof message.specId === "string"
      ) {
        activeSpecId = message.specId;
        const verify = await verifySpec(activeServerUrl, message.specId);
        setSpecStatus(status, verify);
        void specsView?.webview.postMessage({
          kind: "verified",
          verify,
        });
      }
    } catch (err) {
      void specsView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleUsageMessage = async (message: WebviewMessage): Promise<void> => {
    try {
      if (message.kind === "getUsage") await refreshUsage();
    } catch (err) {
      void usageView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleManagerMessage = async (
    message: WebviewMessage,
  ): Promise<void> => {
    try {
      if (
        message.kind === "createManagerFleet" &&
        Array.isArray(message.tasks)
      ) {
        const fleet = await createManagerFleet(activeServerUrl, {
          tasks: message.tasks,
          persist: true,
          model: { provider: "mock" },
        });
        activeManagerFleetId = fleet.id;
        void managerView?.webview.postMessage({ kind: "managerFleet", fleet });
      } else if (
        message.kind === "getManagerFleet" &&
        typeof message.id === "string"
      ) {
        activeManagerFleetId = message.id;
        await refreshManager();
      } else if (
        message.kind === "verifyManagerFleet" &&
        typeof message.id === "string"
      ) {
        activeManagerFleetId = message.id;
        const verify = await verifyManagerFleet(activeServerUrl, message.id);
        void managerView?.webview.postMessage({
          kind: "managerVerify",
          verify,
        });
        await refreshManager();
      }
    } catch (err) {
      void managerView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleAccountMessage = async (
    message: WebviewMessage,
  ): Promise<void> => {
    try {
      if (message.kind === "getAccount") {
        await refreshAccount();
      } else if (message.kind === "signInAccount") {
        const signedIn = await loginAccount(
          activeServerUrl,
          configuredAccountQuery(),
        );
        if (signedIn.evidenceSessionId !== undefined) {
          await streamEvents(
            activeServerUrl,
            signedIn.evidenceSessionId,
            () => {},
          );
        }
        await refreshAccount();
        void accountView?.webview.postMessage({
          kind: "status",
          tone: "ok",
          message: `Signed in through local stub SSO; evidence sealed: ${signedIn.evidenceSessionId ?? "unknown"}.`,
        });
      } else if (message.kind === "signOutAccount") {
        await logoutAccount(activeServerUrl, configuredAccountQuery());
        await refreshAccount();
        void accountView?.webview.postMessage({
          kind: "status",
          tone: "ok",
          message: "Signed out of the local Octopus stub account.",
        });
      } else if (message.kind === "setPriorityTier") {
        if (!isCommercialEdition()) {
          throw new Error("Priority model selection is commercial-only.");
        }
        if (message.tier !== "standard" && message.tier !== "priority") {
          throw new Error("Priority tier must be standard or priority.");
        }
        await vscode.workspace
          .getConfiguration("reef")
          .update(
            "priority.modelTier",
            message.tier,
            vscode.ConfigurationTarget.Global,
          );
        await refreshAccount();
        void accountView?.webview.postMessage({
          kind: "status",
          tone: "ok",
          message: `Priority tier saved for the next gateway run: ${message.tier}.`,
        });
      } else if (
        message.kind === "copyAccountId" &&
        typeof message.id === "string" &&
        message.id.trim() !== ""
      ) {
        await vscode.env.clipboard.writeText(message.id.trim());
        void accountView?.webview.postMessage({
          kind: "status",
          tone: "ok",
          message: "Copied Reef account user id.",
        });
      } else if (message.kind === "recordAccountEvidence") {
        const result = await runTask("C2/C3 account and plan snapshot", {
          account: configuredAccountQuery(),
          persist: true,
        });
        await refreshAccount();
        void accountView?.webview.postMessage({
          kind: "status",
          tone: result.error === undefined ? "ok" : "bad",
          message:
            result.error === undefined
              ? `Account evidence sealed: ${result.sessionId ?? "unknown"}`
              : result.error,
        });
      }
    } catch (err) {
      void accountView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSteeringMessage = async (
    message: WebviewMessage,
  ): Promise<void> => {
    try {
      if (message.kind === "listSteering") {
        await refreshSteering();
      } else if (
        message.kind === "setActiveSteering" &&
        Array.isArray(message.activeIds)
      ) {
        const steering = await setActiveSteering(activeServerUrl, {
          activeIds: message.activeIds,
        });
        void steeringView?.webview.postMessage({
          kind: "steering",
          steering,
        });
      } else if (
        message.kind === "addCustomSteering" &&
        message.input !== undefined
      ) {
        await addCustomSteering(activeServerUrl, message.input);
        await refreshSteering();
      } else if (message.kind === "runSteeringDemo") {
        const result = await runTask("N3 steered mock session");
        void steeringView?.webview.postMessage({
          kind: "status",
          tone: result.error === undefined ? "ok" : "bad",
          message:
            result.error === undefined
              ? `Steered session sealed: ${result.sessionId ?? "unknown"}`
              : result.error,
        });
      }
    } catch (err) {
      void steeringView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleHooksMessage = async (message: WebviewMessage): Promise<void> => {
    try {
      if (message.kind === "listHooks") {
        await refreshHooks();
      } else if (message.kind === "createHook" && message.input !== undefined) {
        await createHook(activeServerUrl, message.input);
        await refreshHooks();
      } else if (
        message.kind === "fireHook" &&
        typeof message.id === "string"
      ) {
        const fired = await fireHook(
          activeServerUrl,
          message.id,
          message.input ?? {},
        );
        void hooksView?.webview.postMessage({
          kind: "status",
          tone: "ok",
          message: `Hook fired into governed session ${fired.sessionId}`,
        });
        await refreshHooks();
      }
    } catch (err) {
      void hooksView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleBrowserMessage = async (
    message: WebviewMessage,
  ): Promise<void> => {
    try {
      if (
        message.kind === "browserPreview" &&
        typeof message.url === "string"
      ) {
        void browserView?.webview.postMessage({
          kind: "status",
          tone: "ok",
          message:
            "Preview loaded locally. Use Governed Read to evidence-log DOM reads.",
        });
      } else if (
        message.kind === "runBrowserDemo" &&
        typeof message.url === "string"
      ) {
        await runBrowserDemo(
          message.mode === "denied" ? "denied" : "allowed",
          message.url,
        );
      } else if (
        message.kind === "runBrowserAnnotation" &&
        typeof message.url === "string" &&
        message.bbox !== undefined
      ) {
        await runBrowserAnnotation(
          message.url,
          message.note ?? "",
          message.bbox,
        );
      }
    } catch (err) {
      void browserView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const openPowersView = (): Thenable<void> =>
    revealView(REEF_POWERS_VIEW_ID, powersView);

  const openSpecsView = (): Thenable<void> =>
    revealView(REEF_SPECS_VIEW_ID, specsView);

  const openUsageView = (): Thenable<void> =>
    revealView(REEF_USAGE_VIEW_ID, usageView);

  const openManagerView = (): Thenable<void> =>
    revealView(REEF_MANAGER_VIEW_ID, managerView);

  const openSteeringView = (): Thenable<void> =>
    revealView(REEF_STEERING_VIEW_ID, steeringView);

  const openHooksView = (): Thenable<void> =>
    revealView(REEF_HOOKS_VIEW_ID, hooksView);

  const openBrowserView = (): Thenable<void> =>
    revealView(REEF_BROWSER_VIEW_ID, browserView);

  const openBrowserPreview = async (): Promise<void> => {
    await openBrowserView();
    const url = configuredBrowserUrl();
    if (url !== "") {
      setTimeout(() => {
        void browserView?.webview.postMessage({ kind: "openUrl", url });
      }, 250);
    }
  };

  const registerReefView = (
    viewId: string,
    scriptFile: string,
    html: (cspSource: string, scriptUri: string) => string,
    setCurrentView: (view: vscode.WebviewView | undefined) => void,
    handleMessage: (message: WebviewMessage) => Promise<void>,
    handleError: (message: string) => void,
    dispose?: () => void,
  ): vscode.Disposable =>
    vscode.window.registerWebviewViewProvider(
      viewId,
      {
        resolveWebviewView(view) {
          setCurrentView(view);
          setViewHtml(view, scriptFile, html);
          view.onDidDispose(() => {
            setCurrentView(undefined);
            dispose?.();
          });
          view.webview.onDidReceiveMessage((message: WebviewMessage) => {
            void (async () => {
              try {
                await handleMessage(message);
              } catch (err) {
                handleError(err instanceof Error ? err.message : String(err));
              }
            })();
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    );

  const sessionViewProvider = registerReefView(
    REEF_SESSION_VIEW_ID,
    "media/webview.js",
    webviewHtml,
    (view) => {
      sessionView = view;
    },
    handleSessionMessage,
    (message) => webviewSurface().error(message),
    () => abort?.abort(),
  );

  const powersViewProvider = registerReefView(
    REEF_POWERS_VIEW_ID,
    "media/powers.js",
    powersWebviewHtml,
    (view) => {
      powersView = view;
    },
    handlePowersMessage,
    (message) =>
      void powersView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message,
      }),
  );

  const specsViewProvider = registerReefView(
    REEF_SPECS_VIEW_ID,
    "media/specs.js",
    specsWebviewHtml,
    (view) => {
      specsView = view;
    },
    handleSpecsMessage,
    (message) =>
      void specsView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message,
      }),
  );

  const accountViewProvider = registerReefView(
    REEF_ACCOUNT_VIEW_ID,
    "media/account.js",
    accountWebviewHtml,
    (view) => {
      accountView = view;
    },
    handleAccountMessage,
    (message) =>
      void accountView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message,
      }),
  );

  const usageViewProvider = registerReefView(
    REEF_USAGE_VIEW_ID,
    "media/usage.js",
    usageWebviewHtml,
    (view) => {
      usageView = view;
    },
    handleUsageMessage,
    (message) =>
      void usageView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message,
      }),
  );

  const managerViewProvider = registerReefView(
    REEF_MANAGER_VIEW_ID,
    "media/manager.js",
    managerWebviewHtml,
    (view) => {
      managerView = view;
    },
    handleManagerMessage,
    (message) =>
      void managerView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message,
      }),
  );

  const steeringViewProvider = registerReefView(
    REEF_STEERING_VIEW_ID,
    "media/steering.js",
    steeringWebviewHtml,
    (view) => {
      steeringView = view;
    },
    handleSteeringMessage,
    (message) =>
      void steeringView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message,
      }),
  );

  const hooksViewProvider = registerReefView(
    REEF_HOOKS_VIEW_ID,
    "media/hooks.js",
    hooksWebviewHtml,
    (view) => {
      hooksView = view;
    },
    handleHooksMessage,
    (message) =>
      void hooksView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message,
      }),
  );

  const browserViewProvider = registerReefView(
    REEF_BROWSER_VIEW_ID,
    "media/browser.js",
    browserWebviewHtml,
    (view) => {
      browserView = view;
    },
    handleBrowserMessage,
    (message) =>
      void browserView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message,
      }),
  );

  const run = vscode.commands.registerCommand("reef.runSession", async () => {
    const task = await vscode.window.showInputBox({
      prompt: "Describe the task for the governed session",
      placeHolder: "add rate limiting to the login endpoint",
    });
    if (task === undefined || task.trim() === "") return;
    await runTask(task);
  });

  const openChat = vscode.commands.registerCommand(
    "reef.openChat",
    async () => {
      const surface = ensureSurface();
      await surface.reveal();
      await postChatConfig();
    },
  );

  const welcome = vscode.commands.registerCommand("reef.openWelcome", () => {
    openWelcomePanel();
  });

  const agentFocus = vscode.commands.registerCommand(
    "reef.openAgentFocus",
    async () => {
      openAgentFocusPanel();
      await moveAgentFocus("focus");
    },
  );

  const verifyAgentFocus = vscode.commands.registerCommand(
    "reef.verifyAgentFocus",
    async () => {
      await verifyFocusSession(true);
    },
  );

  const powers = vscode.commands.registerCommand(
    "reef.openPowers",
    async () => {
      await openPowersView();
      try {
        await refreshPowers();
      } catch (err) {
        void powersView?.webview.postMessage({
          kind: "status",
          tone: "bad",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  const specs = vscode.commands.registerCommand("reef.openSpecs", async () => {
    await openSpecsView();
    try {
      await refreshSpecs();
    } catch (err) {
      void specsView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const usage = vscode.commands.registerCommand("reef.openUsage", async () => {
    await openUsageView();
    try {
      await refreshUsage();
    } catch (err) {
      void usageView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const manager = vscode.commands.registerCommand(
    "reef.openManager",
    async () => {
      await openManagerView();
      try {
        await refreshManager();
      } catch (err) {
        void managerView?.webview.postMessage({
          kind: "status",
          tone: "bad",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  const account = vscode.commands.registerCommand(
    "reef.openAccount",
    async () => {
      await revealView(REEF_ACCOUNT_VIEW_ID, accountView);
      try {
        await refreshAccount();
      } catch (err) {
        void accountView?.webview.postMessage({
          kind: "status",
          tone: "bad",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  const steering = vscode.commands.registerCommand(
    "reef.openSteering",
    async () => {
      await openSteeringView();
      try {
        await refreshSteering();
      } catch (err) {
        void steeringView?.webview.postMessage({
          kind: "status",
          tone: "bad",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  const hooks = vscode.commands.registerCommand("reef.openHooks", async () => {
    await openHooksView();
    try {
      await refreshHooks();
    } catch (err) {
      void hooksView?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const browser = vscode.commands.registerCommand(
    "reef.openBrowser",
    async () => {
      await openBrowserView();
    },
  );

  const browserPreview = vscode.commands.registerCommand(
    "reef.openBrowserPreview",
    async () => {
      await openBrowserPreview();
    },
  );

  const browserRead = vscode.commands.registerCommand(
    "reef.runBrowserRead",
    async () => {
      await runBrowserDemo("allowed", configuredBrowserUrl());
    },
  );

  const browserDenial = vscode.commands.registerCommand(
    "reef.runBrowserDenial",
    async () => {
      await runBrowserDemo("denied", configuredBrowserUrl());
    },
  );

  const browserAnnotation = vscode.commands.registerCommand(
    "reef.runBrowserAnnotation",
    async () => {
      await runBrowserAnnotation(
        configuredBrowserUrl(),
        "N11c verifier annotation",
        {
          x: 480,
          y: 260,
          width: 160,
          height: 90,
          viewportWidth: 1280,
          viewportHeight: 900,
        },
      );
    },
  );

  const mcpDemo = vscode.commands.registerCommand(
    "reef.runMcpDemo",
    async () => {
      await openPowersView();
      await runMcpDemo("allowed");
    },
  );

  const mcpDenyDemo = vscode.commands.registerCommand(
    "reef.runMcpDenialDemo",
    async () => {
      await openPowersView();
      await runMcpDemo("denied");
    },
  );

  const chatApi = (vscode as unknown as { chat?: StableChatApi }).chat;
  const chatParticipant = chatApi?.createChatParticipant(
    "octopus-reef.ide.reef",
    async (request, _context, stream, token) => {
      const task = request.prompt.trim();
      if (task === "") {
        stream.markdown("Give Reef a task to run under governance.");
        return {};
      }

      stream.progress("Starting a governed Reef session...");
      const cancelled = token.onCancellationRequested(() => abort?.abort());
      try {
        const result = await runTask(task);
        if (result.error !== undefined) {
          stream.markdown(`Reef could not run the session: ${result.error}`);
          return { metadata: { error: result.error } };
        }

        if (result.verify !== undefined) {
          const verdict = result.verify.ok ? "verified" : "unverified";
          stream.markdown(
            `Reef governed session \`${result.sessionId ?? "unknown"}\` ${verdict}: work ${result.verify.work}, log ${result.verify.log}, binding ${result.verify.binding}.`,
          );
        } else {
          stream.markdown(
            `Reef governed session \`${result.sessionId ?? "unknown"}\` completed without a sealed verification result.`,
          );
        }
        return { metadata: { sessionId: result.sessionId } };
      } finally {
        cancelled.dispose();
      }
    },
  );
  if (chatParticipant !== undefined) {
    chatParticipant.iconPath = new vscode.ThemeIcon("shield");
  }

  const verify = vscode.commands.registerCommand(
    "reef.verifySession",
    async () => {
      if (agentFocusPanel?.visible === true && focusSessionId !== undefined) {
        await verifyFocusSession(true);
        return;
      }
      if (specsView?.visible === true && activeSpecId !== undefined) {
        const v = await verifySpec(activeServerUrl, activeSpecId);
        setSpecStatus(status, v);
        void specsView.webview.postMessage({ kind: "verified", verify: v });
        void vscode.window.showInformationMessage(
          v.ok
            ? `Reef ✓ SPEC VERIFIED — workstate ${v.work}`
            : `Reef ✗ SPEC UNVERIFIED — workstate ${v.work}`,
        );
        return;
      }
      if (
        lastSessionId === undefined ||
        lastVerify === undefined ||
        lastVerify.type !== "sealed"
      ) {
        void vscode.window.showInformationMessage(
          "Reef: run a session first, then verify it.",
        );
        return;
      }
      const v = await verifySession(activeServerUrl, lastSessionId);
      lastVerify = {
        type: "sealed",
        snapshot: lastVerify.snapshot,
        verify: v,
      };
      ensureSurface().verified(v);
      setStatus(status, v);
      await writeState();
      void vscode.window.showInformationMessage(
        v.ok
          ? `Reef ✓ VERIFIED — work ${v.work}, log ${v.log}, binding ${v.binding}`
          : `Reef ✗ UNVERIFIED — work ${v.work}, log ${v.log}, binding ${v.binding}`,
      );
    },
  );

  const checkForUpdates = vscode.commands.registerCommand(
    "reef.checkForUpdates",
    async () => {
      try {
        const repository = updateRepository();
        const current = await currentProductVersion(context);
        const latest = await latestGitHubRelease(repository);
        const tag = latest.tag_name ?? "";
        const page =
          latest.html_url ?? `https://github.com/${repository}/releases`;
        if (tag === "") {
          throw new Error(
            `GitHub release for ${repository} did not include a tag`,
          );
        }
        const comparison = compareReleaseVersions(tag, current);
        if (comparison > 0) {
          const choice = await vscode.window.showInformationMessage(
            `Reef ${tag} is available. Current version: ${current}.`,
            "Open Release",
          );
          if (choice === "Open Release") {
            await vscode.env.openExternal(vscode.Uri.parse(page));
          }
          return;
        }
        void vscode.window.showInformationMessage(
          `Reef is up to date (${current}). Latest release: ${tag}.`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showWarningMessage(
          `Reef: update check failed (${message})`,
        );
      }
    },
  );
  const commercialDisposables = registerCommercialSurface(context);

  context.subscriptions.push(
    status,
    accountStatus,
    run,
    openChat,
    welcome,
    agentFocus,
    verifyAgentFocus,
    powers,
    specs,
    account,
    usage,
    manager,
    steering,
    hooks,
    browser,
    browserPreview,
    browserRead,
    browserDenial,
    browserAnnotation,
    mcpDemo,
    mcpDenyDemo,
    sessionViewProvider,
    powersViewProvider,
    specsViewProvider,
    accountViewProvider,
    usageViewProvider,
    managerViewProvider,
    steeringViewProvider,
    hooksViewProvider,
    browserViewProvider,
    verify,
    checkForUpdates,
    ...commercialDisposables,
    ...(chatParticipant !== undefined ? [chatParticipant] : []),
    {
      dispose: () => {
        abort?.abort();
        focusAbort?.abort();
        daemon?.kill();
      },
    },
  );

  void (async () => {
    let showWelcomeOnStartup = false;
    try {
      showWelcomeOnStartup = shouldOpenReefWelcome({
        enabled: welcomeEnabled(),
        workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
        uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
      });
      if (showWelcomeOnStartup) {
        openWelcomePanel();
        await revealView(REEF_POWERS_VIEW_ID, powersView);
        await revealView(REEF_SESSION_VIEW_ID, sessionView);
      }
      if (useBundledServer()) {
        const started = await waitForBundledServer(context, persistDir);
        activeServerUrl = started.url;
        daemon = started.process;
      }
      if (!showWelcomeOnStartup && !demoStarted) {
        demoStarted = true;
        await runTask("offline keyless demo: verify a governed Reef session");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (showWelcomeOnStartup) {
        postWelcomeStatus(`Reef startup failed: ${message}`, "bad");
      } else {
        ensureSurface().error(message);
      }
      void vscode.window.showErrorMessage(`Reef: startup failed (${message})`);
    }
  })();
}

export function deactivate(): void {
  /* nothing to clean up beyond the disposables */
}
