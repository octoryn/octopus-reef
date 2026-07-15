export type WelcomeAction = "openProject" | "openRecent" | "cloneConnect";

const WELCOME_ACTIONS = new Set<WelcomeAction>([
  "openProject",
  "openRecent",
  "cloneConnect",
]);

export interface WelcomeStartupDecision {
  readonly enabled: boolean;
  readonly workspaceFolderCount: number;
  readonly uiKind: "desktop" | "web";
}

export function isWelcomeAction(value: unknown): value is WelcomeAction {
  return (
    typeof value === "string" && WELCOME_ACTIONS.has(value as WelcomeAction)
  );
}

export function shouldOpenReefWelcome(
  decision: WelcomeStartupDecision,
): boolean {
  return (
    decision.enabled &&
    decision.workspaceFolderCount === 0 &&
    decision.uiKind === "desktop"
  );
}

export function welcomeCommandForAction(action: WelcomeAction): string {
  switch (action) {
    case "openProject":
      return "workbench.action.files.openFolder";
    case "openRecent":
      return "workbench.action.openRecent";
    case "cloneConnect":
      return "git.clone";
  }
}
