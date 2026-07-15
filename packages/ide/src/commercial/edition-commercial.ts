import * as vscode from "vscode";
import {
  COMMERCIAL_COMMAND,
  commercialSurfaceStatus,
  commercialWebviewHtml,
} from "@octopus-reef/commercial";

export const reefEdition = "commercial";

export function registerCommercialSurface(
  context: vscode.ExtensionContext,
): vscode.Disposable[] {
  let panel: vscode.WebviewPanel | undefined;
  const open = vscode.commands.registerCommand(COMMERCIAL_COMMAND, () => {
    if (panel === undefined) {
      panel = vscode.window.createWebviewPanel(
        "reef.commercial",
        "Reef Commercial",
        vscode.ViewColumn.One,
        { enableScripts: false, retainContextWhenHidden: true },
      );
      panel.onDidDispose(() => {
        panel = undefined;
      });
    }
    const licenseToken = vscode.workspace
      .getConfiguration("reef")
      .get<string>("gateway.licenseToken", "")
      .trim();
    panel.webview.html = commercialWebviewHtml(
      panel.webview.cspSource,
      commercialSurfaceStatus({
        ...(licenseToken !== "" ? { licenseToken } : {}),
      }),
    );
    panel.reveal(vscode.ViewColumn.One);
  });
  return [open];
}
