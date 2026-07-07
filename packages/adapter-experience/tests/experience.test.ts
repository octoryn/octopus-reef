/**
 * M6 (Experience) — causal project memory. A decision remembered with its *why*
 * is recalled by a later `ask`; the answer surfaces the trusted node.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openMemory, rememberDecision, recall } from "../src/index.js";

test("experience: a remembered decision is recalled by a later ask", () => {
  const memory = openMemory(":memory:");
  const id = rememberDecision(
    memory,
    "use SSE not WebSocket",
    "zero runtime dependency, minimal supply chain for a governed tool",
    "ran",
  );
  assert.match(id, /.+/);

  const answer = recall(memory, "SSE");
  assert.ok(answer.hits.length >= 1, "the decision is recalled");
  const titles = answer.hits.map(
    (h) => (h as { node?: { title?: string } }).node?.title,
  );
  assert.ok(titles.includes("use SSE not WebSocket"));
  memory.close();
});

test("experience: an unrelated ask does not surface the decision", () => {
  const memory = openMemory(":memory:");
  rememberDecision(memory, "use SSE not WebSocket", "supply chain", "ran");
  const answer = recall(memory, "kubernetes ingress");
  const titles = answer.hits.map(
    (h) => (h as { node?: { title?: string } }).node?.title,
  );
  assert.ok(!titles.includes("use SSE not WebSocket"));
  memory.close();
});
