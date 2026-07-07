/**
 * M1b — real execution safety: the bidirectional gate protocol, the allowlist
 * (the real "may this run?" gate), and the confined executor.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernedSession,
  NoopExecutor,
  WorkspaceExecutor,
  reefAllowlist,
  type ActionResult,
  type Driver,
  type DriverStep,
} from "../src/index.js";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 7, 0, 0, n++)).toISOString();
}

/** A driver that proposes one action, then echoes its ActionResult into a message. */
function reactiveDriver(action: DriverStep & { type: "action" }): Driver {
  return {
    name: "reactive",
    async *run(): AsyncIterable<DriverStep> {
      const r = (yield action) as ActionResult | undefined;
      yield {
        type: "message",
        text: `result: allowed=${r?.allowed} out=${r?.output ?? ""} err=${r?.error ?? ""}`,
      };
      yield { type: "done", summary: "done" };
    },
  };
}

test("M1b: the action's result is fed back to the driver (bidirectional protocol)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-m1b-"));
  writeFileSync(join(dir, "note.txt"), "SECRET-42");

  const driver = reactiveDriver({
    type: "action",
    action: { type: "read", summary: "read note", target: "note.txt" },
  });
  const session = new GovernedSession({
    id: "b1",
    task: "read a file",
    driver,
    now: clock(),
    authorizer: reefAllowlist(),
    executor: new WorkspaceExecutor(dir),
  });
  const { events } = await session.run();

  assert.ok(
    events.some((e) => e.kind === "message" && e.summary.includes("SECRET-42")),
    "the file content executed and was fed back to the driver",
  );
  assert.equal(session.verify().ok, true);
});

test("M1b: a non-allowlisted command is denied by the authorizer (real gate)", async () => {
  const driver: Driver = {
    name: "wants-npm",
    async *run(): AsyncIterable<DriverStep> {
      yield {
        type: "action",
        action: {
          type: "command",
          summary: "run tests",
          payload: { command: "npm test" },
          required: true,
        },
      };
      yield { type: "done", summary: "done" };
    },
  };
  const session = new GovernedSession({
    id: "b2",
    task: "test it",
    driver,
    now: clock(),
    authorizer: reefAllowlist(),
    executor: new NoopExecutor(),
  });
  const { outcome, snapshot } = await session.run();

  assert.equal(
    snapshot.actionsDenied,
    1,
    "npm test is not on the read-only allowlist",
  );
  assert.equal(outcome, "failed", "a denied required action fails the session");
  assert.equal(session.verify().ok, true);
});

test("M1b: a read-only allowlisted command is authorized", async () => {
  const driver: Driver = {
    name: "git-status",
    async *run(): AsyncIterable<DriverStep> {
      yield {
        type: "action",
        action: {
          type: "command",
          summary: "check status",
          payload: { command: "git status" },
        },
      };
      yield { type: "done", summary: "done" };
    },
  };
  const session = new GovernedSession({
    id: "b3",
    task: "status",
    driver,
    now: clock(),
    authorizer: reefAllowlist(),
    executor: new NoopExecutor(),
  });
  const { snapshot, outcome } = await session.run();
  assert.equal(snapshot.actionsExecuted, 1);
  assert.equal(outcome, "completed");
});

test("M1b: a command with shell operators is never authorized", async () => {
  const auth = reefAllowlist();
  assert.equal(
    auth.can({ id: "x", roles: [], source: "t" }, "reef.action.command", {
      type: "command",
      id: "ls; rm -rf /",
    }),
    false,
  );
  assert.equal(
    auth.can({ id: "x", roles: [], source: "t" }, "reef.action.command", {
      type: "command",
      id: "cat f | sh",
    }),
    false,
  );
  assert.equal(
    auth.can({ id: "x", roles: [], source: "t" }, "reef.action.command", {
      type: "command",
      id: "ls -la",
    }),
    true,
  );
});

test("M1b: WorkspaceExecutor confines reads/writes to the workspace root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-m1b-"));
  const captured: (ActionResult | undefined)[] = [];
  const driver: Driver = {
    name: "escape",
    async *run(): AsyncIterable<DriverStep> {
      captured.push(
        (yield {
          type: "action",
          action: {
            type: "read",
            summary: "escape",
            target: "../../../etc/passwd",
          },
        }) as ActionResult,
      );
      captured.push(
        (yield {
          type: "action",
          action: {
            type: "edit",
            summary: "write in-root",
            target: "out/note.txt",
            payload: { content: "ok" },
          },
        }) as ActionResult,
      );
      captured.push(
        (yield {
          type: "action",
          action: {
            type: "read",
            summary: "read back",
            target: "out/note.txt",
          },
        }) as ActionResult,
      );
      yield { type: "done", summary: "done" };
    },
  };
  const session = new GovernedSession({
    id: "b4",
    task: "fs",
    driver,
    now: clock(),
    authorizer: reefAllowlist(),
    executor: new WorkspaceExecutor(dir),
  });
  await session.run();

  assert.match(
    captured[0]?.error ?? "",
    /escapes the workspace/,
    "traversal is rejected",
  );
  assert.equal(captured[1]?.error, undefined, "an in-root write succeeds");
  assert.equal(captured[2]?.output, "ok", "the written file reads back");
  assert.equal(session.verify().ok, true);
});
