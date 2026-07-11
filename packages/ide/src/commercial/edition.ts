import * as vscode from "vscode";

export type ReefEdition = "community" | "commercial";

/**
 * Resolve the active edition at runtime.
 *
 * Order: the `reef.edition` setting wins, then the `REEF_EDITION` env, then the
 * build default. This build defaults to **commercial** (the hosted gateway
 * distribution); a community/BYOK build sets `reef.edition` (or the setting
 * default) to `"community"`.
 *
 * Commercial edition unlocks the hosted gateway provider — but a session still
 * only routes to the gateway once the user is signed in (a token is present);
 * without one it falls back to BYOK/offline, so this default is safe.
 */
export function reefEdition(): ReefEdition {
  const setting = vscode.workspace
    .getConfiguration("reef")
    .get<string>("edition", "")
    .trim();
  if (setting === "commercial" || setting === "community") return setting;
  if (process.env.REEF_EDITION === "community") return "community";
  return "commercial";
}

export function registerCommercialSurface(
  _context: vscode.ExtensionContext,
): vscode.Disposable[] {
  return [];
}
