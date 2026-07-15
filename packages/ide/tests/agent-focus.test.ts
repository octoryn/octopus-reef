import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ReefEvent,
  UsageSummaryResponse,
  VerifyResult,
} from "@octopus-reef/protocol";
import {
  buildFocusDiff,
  buildFocusRunView,
  extractFocusActions,
  extractFocusPlan,
  focusUsageSnapshot,
  focusVerifyTone,
} from "../src/agentFocus.js";

const EVENTS: readonly ReefEvent[] = [
  event(0, "session.created", 'session opened for "ship N7b"', {
    driver: "mock",
  }),
  event(1, "message", 'Plan: break "ship N7b" into edit and verify.', {}),
  event(2, "action.executed", 'apply change for "ship N7b"', {
    actionType: "edit",
    target: "src/index.ts",
  }),
  event(3, "action.executed", "run the test suite", {
    actionType: "command",
    payload: { command: "npm test" },
  }),
  event(4, "session.sealed", "session sealed", {}),
];

const VERIFY_OK: VerifyResult = {
  ok: true,
  work: "intact",
  log: "intact",
  binding: "bound",
};

test("agent focus: derives plan, actions, and proof diff from evidence", () => {
  assert.deepEqual(extractFocusPlan(EVENTS), [
    'break "ship N7b" into edit and verify.',
  ]);
  assert.deepEqual(
    extractFocusActions(EVENTS).map((action) => [
      action.type,
      action.summary,
      action.command ?? action.target,
    ]),
    [
      ["edit", 'apply change for "ship N7b"', "src/index.ts"],
      ["command", "run the test suite", "npm test"],
    ],
  );

  const diff = buildFocusDiff("ship N7b", EVENTS, VERIFY_OK);
  assert.match(diff, /^\+\+\+ reef-focus\/governed-session/m);
  assert.match(diff, /\+ evidence-links: 5/);
  assert.match(
    diff,
    /\+ action\[2:command:ok\]: run the test suite command=npm test/,
  );
  assert.match(
    diff,
    /\+ verify: VERIFIED: work intact, log intact, binding bound/,
  );
});

test("agent focus: marks tamper verification red", () => {
  const view = buildFocusRunView({
    task: "ship N7b",
    events: EVENTS,
    verify: {
      ok: false,
      work: "intact",
      log: "tampered",
      binding: "unbound",
    },
  });

  assert.equal(
    focusVerifyTone(
      view.verifyLabel.startsWith("UNVERIFIED")
        ? {
            ok: false,
            work: "intact",
            log: "tampered",
            binding: "unbound",
          }
        : undefined,
    ),
    "bad",
  );
  assert.equal(view.verifyTone, "bad");
  assert.match(view.diff, /UNVERIFIED/);
});

test("agent focus: renders honest N6 usage for a session", () => {
  const usage: UsageSummaryResponse = {
    generatedAt: "2026-07-09T00:00:00.000Z",
    totals: {
      calls: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 30,
      costUsd: 0.00009,
    },
    byProvider: [],
    byModel: [],
    sessions: [
      {
        id: "s1",
        task: "ship N7b",
        totals: {
          calls: 1,
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 30,
          costUsd: 0.00009,
        },
        calls: [],
      },
    ],
    remaining: [
      {
        provider: "anthropic",
        status: "pending-key",
        source: "Anthropic Console",
        message: "Live remaining requires BYOK.",
      },
    ],
  };

  const snapshot = focusUsageSnapshot(usage, "s1");
  assert.equal(snapshot.calls, 1);
  assert.equal(snapshot.totalTokens, 30);
  assert.equal(snapshot.cost, "$0.000090");
  assert.match(snapshot.remaining, /pending-key/);
});

function event(
  seq: number,
  kind: ReefEvent["kind"],
  summary: string,
  data: Readonly<Record<string, unknown>>,
): ReefEvent {
  return {
    seq,
    kind,
    summary,
    data,
    at: "2026-07-09T00:00:00.000Z",
    evidenceId: `ev-${seq}`,
  };
}
