import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isWelcomeAction,
  shouldOpenReefWelcome,
  welcomeCommandForAction,
} from "../src/welcome.js";

test("ide welcome: opens only for enabled desktop no-folder startup", () => {
  assert.equal(
    shouldOpenReefWelcome({
      enabled: true,
      workspaceFolderCount: 0,
      uiKind: "desktop",
    }),
    true,
  );
  assert.equal(
    shouldOpenReefWelcome({
      enabled: false,
      workspaceFolderCount: 0,
      uiKind: "desktop",
    }),
    false,
  );
  assert.equal(
    shouldOpenReefWelcome({
      enabled: true,
      workspaceFolderCount: 1,
      uiKind: "desktop",
    }),
    false,
  );
  assert.equal(
    shouldOpenReefWelcome({
      enabled: true,
      workspaceFolderCount: 0,
      uiKind: "web",
    }),
    false,
  );
});

test("ide welcome: maps actions to stable workbench commands", () => {
  assert.equal(isWelcomeAction("openProject"), true);
  assert.equal(isWelcomeAction("openRecent"), true);
  assert.equal(isWelcomeAction("cloneConnect"), true);
  assert.equal(isWelcomeAction("anythingElse"), false);

  assert.equal(
    welcomeCommandForAction("openProject"),
    "workbench.action.files.openFolder",
  );
  assert.equal(
    welcomeCommandForAction("openRecent"),
    "workbench.action.openRecent",
  );
  assert.equal(welcomeCommandForAction("cloneConnect"), "git.clone");
});
