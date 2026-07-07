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
import { createSession, streamEvents, type ServerEvent } from "./client.js";
import { webviewHtml } from "./webview.js";

function serverUrl(): string {
  return vscode.workspace
    .getConfiguration("reef")
    .get<string>("serverUrl", "http://127.0.0.1:4300");
}

function nonce(): string {
  // A CSP nonce must be unpredictable — use a CSPRNG, not Math.random().
  return randomUUID().replace(/-/g, "");
}

export function activate(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let abort: AbortController | undefined;
  let lastVerify: ServerEvent | undefined;

  const ensurePanel = (): vscode.WebviewPanel => {
    if (panel !== undefined) return panel;
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
    return panel;
  };

  const run = vscode.commands.registerCommand("reef.runSession", async () => {
    const task = await vscode.window.showInputBox({
      prompt: "Describe the task for the governed session",
      placeHolder: "add rate limiting to the login endpoint",
    });
    if (task === undefined || task.trim() === "") return;

    const base = serverUrl();
    const view = ensurePanel();
    view.reveal(vscode.ViewColumn.Beside);
    view.webview.postMessage({ kind: "reset", task });
    abort?.abort();
    abort = new AbortController();
    lastVerify = undefined;

    try {
      const id = await createSession(base, task.trim());
      await streamEvents(
        base,
        id,
        (event) => {
          if (event.type === "event") {
            view.webview.postMessage({ kind: "event", event: event.event });
          } else if (event.type === "sealed") {
            lastVerify = event;
            view.webview.postMessage({
              kind: "sealed",
              snapshot: event.snapshot,
              verify: event.verify,
            });
            vscode.window.setStatusBarMessage(
              event.verify.ok ? "Reef ✓ session verified" : "Reef ✗ unverified",
              5000,
            );
          }
        },
        abort.signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      view.webview.postMessage({ kind: "error", message });
      void vscode.window.showErrorMessage(
        `Reef: could not reach the daemon at ${base} — is \`reef serve\` running? (${message})`,
      );
    }
  });

  const verify = vscode.commands.registerCommand(
    "reef.verifySession",
    async () => {
      if (lastVerify === undefined || lastVerify.type !== "sealed") {
        void vscode.window.showInformationMessage(
          "Reef: run a session first, then verify it.",
        );
        return;
      }
      const v = lastVerify.verify;
      void vscode.window.showInformationMessage(
        v.ok
          ? `Reef ✓ VERIFIED — work ${v.work}, log ${v.log}, binding ${v.binding}`
          : `Reef ✗ UNVERIFIED — work ${v.work}, log ${v.log}, binding ${v.binding}`,
      );
    },
  );

  context.subscriptions.push(run, verify, {
    dispose: () => abort?.abort(),
  });
}

export function deactivate(): void {
  /* nothing to clean up beyond the disposables */
}
