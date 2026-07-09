import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatApprovalLabel,
  chatConversationContext,
  chatModelChip,
  chatVerifyTone,
} from "../src/chat.js";

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
