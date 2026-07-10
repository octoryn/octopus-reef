import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatApprovalLabel,
  chatConversationContext,
  chatModelChip,
  chatVerifyTone,
} from "../src/chat.js";
import {
  CHAT_COMMANDS,
  CHAT_ROUTES,
  pickerItems,
  resolveChatAffordances,
  type ChatTaskCandidate,
} from "../src/chatAffordances.js";

test("chat: model chip is honest about keyed Bedrock versus offline mock", () => {
  assert.deepEqual(
    chatModelChip({ provider: "bedrock", name: "Claude Sonnet 4.5" }, {}),
    { label: "Mock · Offline", provider: "mock", keyed: false },
  );

  assert.deepEqual(
    chatModelChip(
      { provider: "bedrock", name: "Claude Sonnet 4.5" },
      { AWS_BEARER_TOKEN_BEDROCK: "test-key" },
    ),
    {
      label: "Bedrock · Claude Sonnet 4.5",
      provider: "bedrock",
      keyed: true,
    },
  );
});

test("chat: autopilot and ask approvals map to evidence request context", () => {
  assert.deepEqual(
    chatConversationContext({
      conversationId: "conv-1",
      turn: 2,
      parentSessionId: "sess-1",
      autopilot: true,
    }),
    {
      id: "conv-1",
      turn: 2,
      parentSessionId: "sess-1",
      autopilot: true,
      approvalMode: "auto",
    },
  );

  assert.deepEqual(
    chatConversationContext({
      conversationId: "conv-1",
      turn: 3,
      autopilot: false,
    }),
    {
      id: "conv-1",
      turn: 3,
      autopilot: false,
      approvalMode: "ask",
    },
  );
  assert.equal(chatApprovalLabel(true), "Autopilot auto-approved");
  assert.equal(chatApprovalLabel(false), "Approval requested and granted");
});

test("chat: per-turn verification tone turns red on tamper verdicts", () => {
  assert.equal(chatVerifyTone(undefined), "pending");
  assert.equal(
    chatVerifyTone({
      ok: true,
      work: "intact",
      log: "intact",
      binding: "bound",
    }),
    "ok",
  );
  assert.equal(
    chatVerifyTone({
      ok: false,
      work: "intact",
      log: "broken: tampered",
      binding: "broken: unbound",
    }),
    "bad",
  );
});

test("chat affordances: commands, tasks, and role-agent routes resolve to governed metadata", () => {
  const task: ChatTaskCandidate = {
    specId: "spec-1",
    specTitle: "N12 Spec",
    itemId: "spec-1-task-1",
    title: "Implement affordances",
    state: "ready",
    evidenceId: "ev_task",
  };

  const resolved = resolveChatAffordances(
    "/plan @code #spec-1-task-1 update the chat",
    [task],
  );
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.affordances.command?.id, "plan");
    assert.equal(resolved.affordances.route.worker, "codeWorker");
    assert.equal(resolved.affordances.taskRef?.itemId, "spec-1-task-1");
  }

  assert.equal(
    pickerItems("/", "ver", [task]).some(
      (item) => "token" in item && item.token === "/verify",
    ),
    true,
  );
  assert.equal(
    pickerItems("#", "task-1", [task]).some(
      (item) => "itemId" in item && item.itemId === "spec-1-task-1",
    ),
    true,
  );
  assert.equal(
    pickerItems("@", "cli:cod", [task]).some(
      (item) => "token" in item && item.token === "@cli:codex",
    ),
    true,
  );
  assert.equal(CHAT_COMMANDS.length, 6);
  assert.equal(CHAT_ROUTES.length, 5);
});

test("chat affordances: unknown tokens are rejected instead of ignored", () => {
  assert.equal(resolveChatAffordances("/destroy things", []).ok, false);
  assert.equal(resolveChatAffordances("@unknown things", []).ok, false);
  assert.equal(resolveChatAffordances("#missing-task things", []).ok, false);
});
