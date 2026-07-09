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
  getUsage,
  getSpec,
  installPower,
  listHooks,
  listPowers,
  listSpecs,
  listSteering,
  setActiveSteering,
  streamEvents,
  verifySpec,
  verifySession,
  type ServerEvent,
} from "./client.js";
import {
  agentFocusWebviewHtml,
  hooksWebviewHtml,
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
      viewColumn: vscode.ViewColumn.Beside,
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

function modelSettings():
  | {
      readonly provider?: string;
      readonly apiKey?: string;
      readonly name?: string;
    }
  | undefined {
  const config = vscode.workspace.getConfiguration("reef");
  const provider = config.get<string>("model.provider", "auto").trim();
  const apiKey = config.get<string>("model.apiKey", "").trim();
  const name = config.get<string>("model.name", "").trim();
  const licenseToken = config.get<string>("gateway.licenseToken", "").trim();
  const gatewayUrl = config.get<string>("gateway.url", "").trim();
  const model = {
    ...(provider !== "" ? { provider } : {}),
    ...(apiKey !== "" ? { apiKey } : {}),
    ...(name !== "" ? { name } : {}),
    ...(licenseToken !== "" ? { licenseToken } : {}),
    ...(gatewayUrl !== "" ? { gatewayUrl } : {}),
  };
  return Object.keys(model).length > 0 ? model : undefined;
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
  let panel: vscode.WebviewPanel | undefined;
  let welcomePanel: vscode.WebviewPanel | undefined;
  let agentFocusPanel: vscode.WebviewPanel | undefined;
  let powersPanel: vscode.WebviewPanel | undefined;
  let hooksPanel: vscode.WebviewPanel | undefined;
  let specsPanel: vscode.WebviewPanel | undefined;
  let steeringPanel: vscode.WebviewPanel | undefined;
  let usagePanel: vscode.WebviewPanel | undefined;
  let textSurface: ReefTextSurface | undefined;
  let abort: AbortController | undefined;
  let focusAbort: AbortController | undefined;
  let lastVerify: ServerEvent | undefined;
  let lastSessionId: string | undefined;
  let lastSessionDir: string | undefined;
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
  setStatus(status, undefined, "Reef idle");

  const webviewSurface = (): ReefSurface => ({
    reveal: () => panel?.reveal(vscode.ViewColumn.Beside),
    reset: (task) => void panel?.webview.postMessage({ kind: "reset", task }),
    event: (event) => void panel?.webview.postMessage({ kind: "event", event }),
    sealed: (event) =>
      void panel?.webview.postMessage({
        kind: "sealed",
        snapshot: event.snapshot,
        verify: event.verify,
      }),
    verified: (verify) =>
      void panel?.webview.postMessage({ kind: "verified", verify }),
    error: (message) =>
      void panel?.webview.postMessage({ kind: "error", message }),
  });

  const ensureSurface = (): ReefSurface => {
    if (vscode.env.uiKind === vscode.UIKind.Web) {
      textSurface ??= new ReefTextSurface(context);
      return textSurface;
    }
    if (panel === undefined) {
      panel = vscode.window.createWebviewPanel(
        "reef.session",
        "Reef Session",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = webviewHtml(
        panel.webview.cspSource,
        panel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, "media", "webview.js"),
          )
          .toString(),
      );
      panel.onDidDispose(() => {
        panel = undefined;
        abort?.abort();
      });
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void (async () => {
          try {
            if (message.kind === "chatReady") {
              await postChatConfig();
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
          } catch (err) {
            webviewSurface().error(
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
      });
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
    void panel?.webview.postMessage({
      kind: "chatConfig",
      conversationId: chatConversationId,
      modelChip: chatModelChip(modelSettings(), process.env),
      usage: focusUsageSnapshot(usage, lastSessionId),
    });
  };

  const postChatUsage = async (): Promise<void> => {
    const usage = await getUsage(activeServerUrl);
    void panel?.webview.postMessage({
      kind: "chatUsage",
      usage: focusUsageSnapshot(usage, lastSessionId),
    });
  };

  const postChatError = (message: string, turnId?: string): void => {
    void panel?.webview.postMessage({
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
    void panel?.webview.postMessage({
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
      readonly spec?: {
        readonly specId?: string;
        readonly itemId?: string;
        readonly to?: WorkState;
        readonly reason?: string;
      };
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
        persist: true,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(extra.mcp !== undefined ? { mcp: extra.mcp } : {}),
        ...(extra.spec !== undefined ? { spec: extra.spec } : {}),
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
    const workspaceRoot = firstWorkspaceRoot();
    const model = modelSettings();
    chatConversationId = input.conversationId;
    const parentSessionId = [...chatTurns.values()]
      .filter((turn) => turn.sessionId !== undefined)
      .sort((a, b) => b.turn - a.turn)[0]?.sessionId;
    const conversation: ChatConversationContext = chatConversationContext({
      conversationId: input.conversationId,
      turn: input.turn,
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      autopilot: input.autopilot,
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
    void panel?.webview.postMessage({
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
      void panel?.webview.postMessage({
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
            void panel?.webview.postMessage({
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
            void panel?.webview.postMessage({
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
    void powersPanel?.webview.postMessage({
      kind: "status",
      tone: result.error === undefined ? "ok" : "bad",
      message:
        result.error === undefined
          ? `Governed MCP ${mode} session sealed: ${result.sessionId ?? "unknown"}`
          : result.error,
    });
  };

  const refreshPowers = async (): Promise<void> => {
    const powers = await listPowers(activeServerUrl);
    void powersPanel?.webview.postMessage({ kind: "powers", powers });
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
    void specsPanel?.webview.postMessage({ kind: "specs", specs });
    if (activeSpecId !== undefined) {
      const spec = await getSpec(activeServerUrl, activeSpecId);
      void specsPanel?.webview.postMessage({ kind: "spec", spec });
    }
  };

  const refreshUsage = async (): Promise<void> => {
    const usage = await getUsage(activeServerUrl);
    void usagePanel?.webview.postMessage({ kind: "usage", usage });
  };

  const refreshSteering = async (): Promise<void> => {
    const steering = await listSteering(activeServerUrl);
    void steeringPanel?.webview.postMessage({ kind: "steering", steering });
  };

  const refreshHooks = async (): Promise<void> => {
    const hooks = await listHooks(activeServerUrl);
    void hooksPanel?.webview.postMessage({ kind: "hooks", hooks });
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
      void specsPanel?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: result.error,
      });
      return;
    }
    await refreshSpecs();
    void specsPanel?.webview.postMessage({
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

  const openPowersPanel = (): void => {
    if (powersPanel === undefined) {
      powersPanel = vscode.window.createWebviewPanel(
        "reef.powers",
        "Reef Powers",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      powersPanel.webview.html = powersWebviewHtml(
        powersPanel.webview.cspSource,
        powersPanel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, "media", "powers.js"),
          )
          .toString(),
      );
      powersPanel.onDidDispose(() => {
        powersPanel = undefined;
      });
      powersPanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void (async () => {
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
              await runMcpDemo(
                message.mode === "denied" ? "denied" : "allowed",
              );
            }
          } catch (err) {
            void powersPanel?.webview.postMessage({
              kind: "status",
              tone: "bad",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      });
    }
    powersPanel.reveal(vscode.ViewColumn.Beside);
  };

  const openSpecsPanel = (): void => {
    if (specsPanel === undefined) {
      specsPanel = vscode.window.createWebviewPanel(
        "reef.specs",
        "Reef Specs",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      specsPanel.webview.html = specsWebviewHtml(
        specsPanel.webview.cspSource,
        specsPanel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, "media", "specs.js"),
          )
          .toString(),
      );
      specsPanel.onDidDispose(() => {
        specsPanel = undefined;
      });
      specsPanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void (async () => {
          try {
            if (message.kind === "listSpecs") {
              await refreshSpecs();
            } else if (message.kind === "createSpec") {
              const spec = await createSpec(activeServerUrl, {
                ...(typeof message.title === "string" &&
                message.title.trim() !== ""
                  ? { title: message.title.trim() }
                  : {}),
                ...(Array.isArray(message.tasks)
                  ? { tasks: message.tasks }
                  : {}),
              });
              activeSpecId = spec.id;
              await refreshSpecs();
              void specsPanel?.webview.postMessage({
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
              void specsPanel?.webview.postMessage({ kind: "spec", spec });
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
                  ...(message.reason !== undefined
                    ? { reason: message.reason }
                    : {}),
                });
                void specsPanel?.webview.postMessage({
                  kind: "status",
                  tone: "bad",
                  message: "Illegal transition unexpectedly succeeded.",
                });
              } catch (err) {
                void specsPanel?.webview.postMessage({
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
              void specsPanel?.webview.postMessage({
                kind: "verified",
                verify,
              });
            }
          } catch (err) {
            void specsPanel?.webview.postMessage({
              kind: "status",
              tone: "bad",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      });
    }
    specsPanel.reveal(vscode.ViewColumn.Beside);
  };

  const openUsagePanel = (): void => {
    if (usagePanel === undefined) {
      usagePanel = vscode.window.createWebviewPanel(
        "reef.usage",
        "Reef Usage",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      usagePanel.webview.html = usageWebviewHtml(
        usagePanel.webview.cspSource,
        usagePanel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, "media", "usage.js"),
          )
          .toString(),
      );
      usagePanel.onDidDispose(() => {
        usagePanel = undefined;
      });
      usagePanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void (async () => {
          try {
            if (message.kind === "getUsage") await refreshUsage();
          } catch (err) {
            void usagePanel?.webview.postMessage({
              kind: "status",
              tone: "bad",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      });
    }
    usagePanel.reveal(vscode.ViewColumn.Beside);
  };

  const openSteeringPanel = (): void => {
    if (steeringPanel === undefined) {
      steeringPanel = vscode.window.createWebviewPanel(
        "reef.steering",
        "Reef Steering",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      steeringPanel.webview.html = steeringWebviewHtml(
        steeringPanel.webview.cspSource,
        steeringPanel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, "media", "steering.js"),
          )
          .toString(),
      );
      steeringPanel.onDidDispose(() => {
        steeringPanel = undefined;
      });
      steeringPanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void (async () => {
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
              void steeringPanel?.webview.postMessage({
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
              void steeringPanel?.webview.postMessage({
                kind: "status",
                tone: result.error === undefined ? "ok" : "bad",
                message:
                  result.error === undefined
                    ? `Steered session sealed: ${result.sessionId ?? "unknown"}`
                    : result.error,
              });
            }
          } catch (err) {
            void steeringPanel?.webview.postMessage({
              kind: "status",
              tone: "bad",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      });
    }
    steeringPanel.reveal(vscode.ViewColumn.Beside);
  };

  const openHooksPanel = (): void => {
    if (hooksPanel === undefined) {
      hooksPanel = vscode.window.createWebviewPanel(
        "reef.hooks",
        "Reef Hooks",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      hooksPanel.webview.html = hooksWebviewHtml(
        hooksPanel.webview.cspSource,
        hooksPanel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, "media", "hooks.js"),
          )
          .toString(),
      );
      hooksPanel.onDidDispose(() => {
        hooksPanel = undefined;
      });
      hooksPanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void (async () => {
          try {
            if (message.kind === "listHooks") {
              await refreshHooks();
            } else if (
              message.kind === "createHook" &&
              message.input !== undefined
            ) {
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
              void hooksPanel?.webview.postMessage({
                kind: "status",
                tone: "ok",
                message: `Hook fired into governed session ${fired.sessionId}`,
              });
              await refreshHooks();
            }
          } catch (err) {
            void hooksPanel?.webview.postMessage({
              kind: "status",
              tone: "bad",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      });
    }
    hooksPanel.reveal(vscode.ViewColumn.Beside);
  };

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
      openPowersPanel();
      try {
        await refreshPowers();
      } catch (err) {
        void powersPanel?.webview.postMessage({
          kind: "status",
          tone: "bad",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  const specs = vscode.commands.registerCommand("reef.openSpecs", async () => {
    openSpecsPanel();
    try {
      await refreshSpecs();
    } catch (err) {
      void specsPanel?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const usage = vscode.commands.registerCommand("reef.openUsage", async () => {
    openUsagePanel();
    try {
      await refreshUsage();
    } catch (err) {
      void usagePanel?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const steering = vscode.commands.registerCommand(
    "reef.openSteering",
    async () => {
      openSteeringPanel();
      try {
        await refreshSteering();
      } catch (err) {
        void steeringPanel?.webview.postMessage({
          kind: "status",
          tone: "bad",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  const hooks = vscode.commands.registerCommand("reef.openHooks", async () => {
    openHooksPanel();
    try {
      await refreshHooks();
    } catch (err) {
      void hooksPanel?.webview.postMessage({
        kind: "status",
        tone: "bad",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const mcpDemo = vscode.commands.registerCommand(
    "reef.runMcpDemo",
    async () => {
      openPowersPanel();
      await runMcpDemo("allowed");
    },
  );

  const mcpDenyDemo = vscode.commands.registerCommand(
    "reef.runMcpDenialDemo",
    async () => {
      openPowersPanel();
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
      if (specsPanel?.visible === true && activeSpecId !== undefined) {
        const v = await verifySpec(activeServerUrl, activeSpecId);
        setSpecStatus(status, v);
        void specsPanel.webview.postMessage({ kind: "verified", verify: v });
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
    run,
    openChat,
    welcome,
    agentFocus,
    verifyAgentFocus,
    powers,
    specs,
    usage,
    steering,
    hooks,
    mcpDemo,
    mcpDenyDemo,
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
