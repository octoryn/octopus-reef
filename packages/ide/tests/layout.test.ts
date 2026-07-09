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
      ["reef.steering", "webview"],
      ["reef.hooks", "webview"],
      ["reef.usage", "webview"],
    ],
  );
});
