/**
 * Network-free tests for ClaudeDriver: a fake client returns a canned plan, and
 * we assert the driver maps it to governed DriverSteps and that a real
 * GovernedSession runs + verifies over it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GovernedSession } from "@octopus-reef/engine";
import { ClaudeDriver, type ClaudeMessagesClient } from "../src/index.js";

function fakeClient(plan: unknown): ClaudeMessagesClient {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify(plan) }],
      }),
    },
  };
}

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 7, 0, 0, n++)).toISOString();
}

test("ClaudeDriver maps a plan into governed steps and the session verifies", async () => {
  const plan = {
    summary: "add a rate limiter to the API",
    steps: [
      { kind: "observe", summary: "scanned the API routes" },
      { kind: "message", summary: "will add a token-bucket limiter" },
      {
        kind: "action",
        summary: "edit the middleware",
        actionType: "edit",
        target: "src/mw.ts",
      },
      {
        kind: "action",
        summary: "run the tests",
        actionType: "command",
        command: "npm test",
      },
    ],
  };
  const driver = new ClaudeDriver({ client: fakeClient(plan) });
  const session = new GovernedSession({
    id: "c1",
    task: "rate limit",
    driver,
    now: clock(),
  });
  const { snapshot, outcome } = await session.run();

  assert.equal(outcome, "completed");
  assert.equal(
    snapshot.actionsExecuted,
    2,
    "both proposed actions are gated and recorded",
  );
  assert.equal(session.verify().ok, true);
});

test("a dangerous command in the plan is denied by the gate", async () => {
  const plan = {
    summary: "clean up",
    steps: [
      {
        kind: "action",
        summary: "wipe",
        actionType: "command",
        command: "rm -rf /",
        required: true,
      },
    ],
  };
  const driver = new ClaudeDriver({ client: fakeClient(plan) });
  const session = new GovernedSession({
    id: "c2",
    task: "clean",
    driver,
    now: clock(),
  });
  const { outcome, snapshot } = await session.run();

  assert.equal(
    snapshot.actionsDenied,
    1,
    "rm -rf / must be denied even from a real driver",
  );
  assert.equal(outcome, "failed", "a denied required action fails the session");
});

test("an unparseable model response fails the session cleanly", async () => {
  const bad: ClaudeMessagesClient = {
    messages: {
      create: async () => ({ content: [{ type: "text", text: "not json" }] }),
    },
  };
  const session = new GovernedSession({
    id: "c3",
    task: "x",
    driver: new ClaudeDriver({ client: bad }),
    now: clock(),
  });
  const { outcome } = await session.run();
  assert.equal(outcome, "failed");
});
