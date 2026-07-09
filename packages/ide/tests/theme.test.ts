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

test("theme: Reef Dark is shipped and contributed as the default", () => {
  const pkg = readJson("package.json");
  const themes = pkg.contributes?.themes ?? [];
  const reefTheme = themes.find(
    (theme: any) => theme.id === "octopus-reef.dark",
  );

  assert.deepEqual(reefTheme, {
    id: "octopus-reef.dark",
    label: "Reef Dark",
    uiTheme: "vs-dark",
    path: "./themes/reef-dark-color-theme.json",
  });
  assert.equal(
    pkg.contributes?.configurationDefaults?.["workbench.colorTheme"],
    "octopus-reef.dark",
  );
  assert.equal(
    pkg.contributes?.configurationDefaults?.["workbench.startupEditor"],
    "none",
  );
});

test("theme: Reef Dark palette matches the Reef webview chrome colors", () => {
  const theme = readJson("themes/reef-dark-color-theme.json");
  const colors = theme.colors ?? {};

  assert.equal(theme.name, "Reef Dark");
  assert.equal(theme.type, "dark");
  assert.equal(colors["editor.background"], "#0a0e15");
  assert.equal(colors["activityBar.background"], "#0a0e15");
  assert.equal(colors["sideBar.background"], "#0d1219");
  assert.equal(colors["titleBar.activeBackground"], "#0a0e15");
  assert.equal(colors["statusBar.background"], "#0d1219");
  assert.equal(colors["panel.background"], "#0a0e15");
  assert.equal(colors["focusBorder"], "#33e6c0");
  assert.equal(colors["button.background"], "#33e6c0");
  assert.equal(colors["activityBarBadge.background"], "#33e6c0");
  assert.equal(colors["progressBar.background"], "#33e6c0");
  assert.equal(colors["tab.activeBorderTop"], "#33e6c0");
});
