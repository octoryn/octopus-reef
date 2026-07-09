/**
 * The Reef VS Code extension. Run a governed session from the command palette,
 * watch its tamper-evident evidence chain stream into a panel, and see it seal
 * and verify — the editor-native form of the same proof the CLI and web show.
 *
 * The extension host owns the daemon connection (fetch + SSE); the webview is
 * pure presentation, fed via postMessage.
 */
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createSession,
  streamEvents,
  verifySession,
  type ServerEvent,
} from "./client.js";
import { webviewHtml } from "./webview.js";

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

class ReefTextSurface implements ReefSurface, vscode.TextDocumentContentProvider {
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
      vscode.workspace.registerTextDocumentContentProvider("reef-session", this),
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
  const a = normalizeReleaseVersion(left).split(".").map((part) => Number(part));
  const b = normalizeReleaseVersion(right).split(".").map((part) => Number(part));
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

function nonce(): string {
  // A CSP nonce must be unpredictable — use a CSPRNG, not Math.random().
  return randomUUID().replace(/-/g, "");
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
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  }
  item.show();
}

async function waitForBundledServer(
  context: vscode.ExtensionContext,
  persistDir: string,
): Promise<{ url: string; process: ChildProcess }> {
  await mkdir(persistDir, { recursive: true });
  const serverPath = context.asAbsolutePath("server/reef-server.cjs");
  const child = spawn(
    process.execPath,
    [serverPath, "--port", "0", "--host", "127.0.0.1", "--persist", persistDir],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        REEF_BUNDLED_DAEMON: "1",
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
  let textSurface: ReefTextSurface | undefined;
  let abort: AbortController | undefined;
  let lastVerify: ServerEvent | undefined;
  let lastSessionId: string | undefined;
  let lastSessionDir: string | undefined;
  let activeServerUrl = serverUrl();
  let daemon: ChildProcess | undefined;
  let demoStarted = false;
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
      panel.webview.html = webviewHtml(panel.webview.cspSource, nonce());
      panel.onDidDispose(() => {
        panel = undefined;
        abort?.abort();
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

  const runTask = async (task: string): Promise<void> => {
    const base = activeServerUrl;
    const surface = ensureSurface();
    await surface.reveal();
    surface.reset(task);
    abort?.abort();
    abort = new AbortController();
    lastVerify = undefined;
    lastSessionId = undefined;
    lastSessionDir = undefined;
    setStatus(status, undefined);

    try {
      const id = await createSession(base, task.trim(), undefined, true);
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
            surface.sealed(event);
            setStatus(status, event.verify);
            void writeState();
          }
        },
        abort.signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      surface.error(message);
      status.text = "Reef ✗ session failed";
      status.tooltip = message;
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      status.show();
      void vscode.window.showErrorMessage(
        `Reef: could not reach the daemon at ${base} — is \`reef serve\` running? (${message})`,
      );
    }
  };

  const run = vscode.commands.registerCommand("reef.runSession", async () => {
    const task = await vscode.window.showInputBox({
      prompt: "Describe the task for the governed session",
      placeHolder: "add rate limiting to the login endpoint",
    });
    if (task === undefined || task.trim() === "") return;
    await runTask(task);
  });

  const verify = vscode.commands.registerCommand(
    "reef.verifySession",
    async () => {
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
        const page = latest.html_url ?? `https://github.com/${repository}/releases`;
        if (tag === "") {
          throw new Error(`GitHub release for ${repository} did not include a tag`);
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

  context.subscriptions.push(status, run, verify, checkForUpdates, {
    dispose: () => {
      abort?.abort();
      daemon?.kill();
    },
  });

  void (async () => {
    try {
      if (useBundledServer()) {
        const started = await waitForBundledServer(context, persistDir);
        activeServerUrl = started.url;
        daemon = started.process;
      }
      if (!demoStarted) {
        demoStarted = true;
        await runTask("offline keyless demo: verify a governed Reef session");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ensureSurface().error(message);
      void vscode.window.showErrorMessage(`Reef: startup failed (${message})`);
    }
  })();
}

export function deactivate(): void {
  /* nothing to clean up beyond the disposables */
}
