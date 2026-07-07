/**
 * M6 (Observe) — the Reef input boundary. An untrusted agent input is validated
 * into a canonical Observation and bridged to evidence; a malformed input is
 * rejected and never becomes evidence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentBoundary,
  ingestToEvidence,
  mcpToolCallEvent,
  agentActionEvent,
} from "../src/index.js";

test("observe boundary: a valid tool call becomes a canonical observation + evidence", async () => {
  const observe = agentBoundary();
  const result = await ingestToEvidence(
    observe,
    mcpToolCallEvent({
      tool: "read_file",
      server: "fs",
      args: { path: "a.txt" },
      agent: { id: "claude" },
      occurredAt: "2026-07-07T00:00:00.000Z",
    }),
  );
  assert.equal(result.status, "accepted");
  if (result.status !== "rejected") {
    assert.equal(result.observation.type, "AgentToolCalled");
    assert.match(result.evidence.id, /^ev_/);
    assert.equal(result.evidence.kind, "observation:AgentToolCalled");
  }
});

test("observe boundary: an agent action is validated + bridged too", async () => {
  const observe = agentBoundary();
  const result = await ingestToEvidence(
    observe,
    agentActionEvent({
      action: "edit_file",
      agent: { id: "claude" },
      occurredAt: "2026-07-07T00:00:01.000Z",
    }),
  );
  assert.equal(result.status, "accepted");
  if (result.status !== "rejected") {
    assert.equal(result.observation.type, "AgentAction");
  }
});

test("observe boundary: a malformed input is rejected, mints no evidence", async () => {
  const observe = agentBoundary();
  const result = await ingestToEvidence(
    observe,
    mcpToolCallEvent({ tool: "", agent: { id: "" } }),
  );
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") {
    assert.equal(result.rejection.reason, "MALFORMED_ENVELOPE");
  }
});

test("observe boundary: keyed evidence is HMAC-bound to the secret", async () => {
  const observe = agentBoundary();
  const result = await ingestToEvidence(
    observe,
    mcpToolCallEvent({
      tool: "search",
      agent: { id: "claude" },
      occurredAt: "2026-07-07T00:00:02.000Z",
    }),
    "s3cr3t",
  );
  assert.equal(result.status, "accepted");
  if (result.status !== "rejected") {
    assert.ok(result.evidence.integrity.length > 0);
  }
});
