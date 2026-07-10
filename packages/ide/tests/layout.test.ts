import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ideRoot = path.resolve(__dirname, "..");

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(path.join(ideRoot, relativePath), "utf8"));
}

test("layout: Reef session is contributed as a right docked webview view", () => {
  const pkg = readJson("package.json");
  const secondary = pkg.contributes?.viewsContainers?.secondarySidebar ?? [];
  assert.deepEqual(secondary, [
    {
      id: "reef-session-dock",
      title: "Reef",
      icon: "$(comment-discussion)",
    },
  ]);

  const dockedViews = pkg.contributes?.views?.["reef-session-dock"] ?? [];
  assert.deepEqual(dockedViews, [
    {
      type: "webview",
      id: "reef.session",
      name: "Session",
      icon: "$(comment-discussion)",
      visibility: "visible",
    },
  ]);
});

test("layout: Reef tools are contributed as left activity-bar webview views", () => {
  const pkg = readJson("package.json");
  const activity = pkg.contributes?.viewsContainers?.activitybar ?? [];
  assert.deepEqual(activity, [
    {
      id: "reef",
      title: "Reef",
      icon: "$(beaker)",
    },
  ]);

  const reefViews = pkg.contributes?.views?.reef ?? [];
  assert.deepEqual(
    reefViews.map((view: any) => [view.id, view.type]),
    [
      ["reef.powers", "webview"],
      ["reef.browser", "webview"],
      ["reef.specs", "webview"],
      ["reef.account", "webview"],
      ["reef.steering", "webview"],
      ["reef.hooks", "webview"],
      ["reef.usage", "webview"],
    ],
  );
});

test("layout: Reef Browser has command and local URL configuration", () => {
  const pkg = readJson("package.json");
  const commands = new Set(
    (pkg.contributes?.commands ?? []).map((entry: any) => entry.command),
  );
  assert.equal(commands.has("reef.openBrowserPreview"), true);
  assert.equal(commands.has("reef.runBrowserRead"), true);
  assert.equal(commands.has("reef.runBrowserDenial"), true);
  assert.equal(commands.has("reef.runBrowserAnnotation"), true);
  assert.equal(
    pkg.contributes?.configuration?.properties?.["reef.browser.url"]?.default,
    "http://127.0.0.1:5173/",
  );
});

test("layout: Reef Account & Plan is opened through a docked view command", () => {
  const pkg = readJson("package.json");
  const commands = new Set(
    (pkg.contributes?.commands ?? []).map((entry: any) => entry.command),
  );
  assert.equal(commands.has("reef.openAccount"), true);
  const reefViews = pkg.contributes?.views?.reef ?? [];
  assert.equal(
    reefViews.some(
      (view: any) => view.id === "reef.account" && view.type === "webview",
    ),
    true,
  );
});

test("layout: Reef suppresses stock startup welcome and avoids beside editor reveals", () => {
  const pkg = readJson("package.json");
  assert.equal(
    pkg.contributes?.configurationDefaults?.["workbench.startupEditor"],
    "none",
  );

  const extensionSource = readFileSync(
    path.join(ideRoot, "src", "extension.ts"),
    "utf8",
  );
  assert.equal(extensionSource.includes("ViewColumn.Beside"), false);
  assert.match(
    extensionSource,
    /if \(showWelcomeOnStartup\) \{\s+openWelcomePanel\(\);\s+await revealView\(REEF_POWERS_VIEW_ID, powersView\);\s+await revealView\(REEF_SESSION_VIEW_ID, sessionView\);/s,
  );
});

test("layout: docked session header controls are handled by the extension host", () => {
  const extensionSource = readFileSync(
    path.join(ideRoot, "src", "extension.ts"),
    "utf8",
  );
  const start = extensionSource.indexOf("const handleSessionMessage");
  const end = extensionSource.indexOf("const handlePowersMessage");
  const handler = extensionSource.slice(start, end);
  assert.match(handler, /message\.kind === "openAgentFocus"/);
  assert.match(handler, /message\.kind === "newSession"/);
  assert.match(handler, /await startNewChatSession\(\)/);
  assert.match(handler, /message\.kind === "showSessionMenu"/);
  assert.match(handler, /kind: "sessionMenu", open: true/);

  const sessionScript = readFileSync(
    path.join(ideRoot, "media", "webview.js"),
    "utf8",
  );
  assert.match(sessionScript, /new-session-tab/);
  assert.match(sessionScript, /new-session-plus/);
  assert.match(sessionScript, /kind: "newSession"/);
  assert.match(sessionScript, /kind: "showSessionMenu"/);
});

test("layout: left Reef panels use the shared polish and Usage keeps sourced values", () => {
  const webviewSource = readFileSync(
    path.join(ideRoot, "src", "webview.ts"),
    "utf8",
  );
  for (const title of [
    "Powers",
    "Browser",
    "Specs",
    "Account &amp; Plan",
    "Steering",
    "Hooks",
    "Usage",
  ]) {
    assert.match(webviewSource, new RegExp(`<h1>${title}</h1>`));
  }
  assert.match(webviewSource, /class="usage-summary"/);
  assert.match(webviewSource, /id="total-tokens"/);
  assert.match(webviewSource, /Session and provider detail/);

  const usageScript = readFileSync(
    path.join(ideRoot, "media", "usage.js"),
    "utf8",
  );
  assert.match(usageScript, /Number\(totals\.inputTokens \|\| 0\) \+ Number\(totals\.outputTokens \|\| 0\)/);
  assert.match(usageScript, /Provider-normalized cost from persisted usage evidence/);
  assert.match(usageScript, /Cost is not available from the configured provider/);
});
