/**
 * Network-free tests for the conductor: plan → route → govern each sub-session →
 * a Worker Ledger that independently verifies and PINS each sub-session. Fake
 * planner/router make routing deterministic; a real tool-worker proves the pins
 * are real chain heads; the LLM planner/router are unit-tested with a text
 * provider (no network).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Tool } from "@octopus-reef/engine";
import {
  Orchestrator,
  LlmPlanner,
  LlmRouter,
  toolWorker,
  verifyLedger,
  type CompletionRequest,
  type CompletionResponse,
  type ModelProvider,
  type Planner,
  type Router,
  type Subtask,
  type Worker,
  type WorkerResult,
} from "../src/index.js";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 8, 0, 0, n++)).toISOString();
}

/** A provider that replays canned TEXT responses (for planner/router). */
class TextProvider implements ModelProvider {
  readonly name = "text";
  #queue: string[];
  constructor(texts: string[]) {
    this.#queue = [...texts];
  }
  complete(_req: CompletionRequest): Promise<CompletionResponse> {
    const text = this.#queue.shift() ?? "";
    return Promise.resolve({
      content: [{ type: "text", text }],
      stopReason: "end_turn",
    });
  }
}

/** A provider that replays canned tool_use responses (for the worker). */
class ToolUseProvider implements ModelProvider {
  readonly name = "tooluse";
  #queue: CompletionResponse[];
  constructor(queue: CompletionResponse[]) {
    this.#queue = [...queue];
  }
  complete(_req: CompletionRequest): Promise<CompletionResponse> {
    const next = this.#queue.shift();
    if (next === undefined) throw new Error("script exhausted");
    return Promise.resolve(next);
  }
}
const useTool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
): CompletionResponse => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

const fakePlanner = (subtasks: Subtask[]): Planner => ({
  plan: () => Promise.resolve(subtasks),
});
const keywordRouter: Router = {
  route: (subtask, workers) =>
    Promise.resolve(
      /code|fix|test/i.test(subtask)
        ? { worker: "code", reason: "a coding subtask" }
        : {
            worker: workers.find((w) => w.name !== "code")?.name ?? "code",
            reason: "not coding",
          },
    ),
};
const fakeWorker = (name: string): Worker => ({
  name,
  description: `the ${name} worker`,
  run: (subtask): Promise<WorkerResult> =>
    Promise.resolve({
      outcome: "completed",
      output: `${name} handled: ${subtask}`,
      workHead: `wh-${name}`,
      logHead: `lh-${name}`,
      verified: true,
    }),
});

test("orchestrator plans, routes, and builds a verifiable Worker Ledger", async () => {
  const planner = fakePlanner([
    { id: "st1", description: "fix the failing test in the parser" },
    { id: "st2", description: "look up the current exchange rate" },
  ]);
  const orch = new Orchestrator({
    workers: [fakeWorker("code"), fakeWorker("tools")],
    planner,
    router: keywordRouter,
    now: clock(),
  });

  const result = await orch.orchestrate("ship the feature");
  assert.equal(result.outcome, "completed");
  assert.equal(result.verified, true, "the ledger independently verifies");
  assert.deepEqual(
    result.steps.map((s) => s.worker),
    ["code", "tools"],
    "each subtask routed to the right worker",
  );

  // The ledger records plan + (route, result) per subtask + done.
  const kinds = result.ledger.evidence.map((e) => e.kind);
  assert.deepEqual(kinds, [
    "orchestration.plan",
    "orchestration.route",
    "orchestration.result",
    "orchestration.route",
    "orchestration.result",
    "orchestration.done",
  ]);
  // Each result pins its sub-session's heads (swap-proof).
  const firstResult = result.ledger.evidence.find(
    (e) => e.kind === "orchestration.result",
  )!;
  assert.equal(
    (firstResult.content as { workHead: string }).workHead,
    "wh-code",
  );
});

test("a tampered Worker Ledger fails verification", async () => {
  const orch = new Orchestrator({
    workers: [fakeWorker("code"), fakeWorker("tools")],
    planner: fakePlanner([{ id: "st1", description: "do a thing" }]),
    router: keywordRouter,
    now: clock(),
  });
  const result = await orch.orchestrate("task");
  assert.equal(verifyLedger(result.ledger), true);

  const tampered = JSON.parse(
    JSON.stringify(result.ledger),
  ) as typeof result.ledger;
  (tampered.evidence[0]!.content as { task: string }).task = "a different task";
  assert.equal(verifyLedger(tampered), false, "one byte flips → unverifiable");
});

test("a real tool-worker's governed sub-session is pinned in the ledger", async () => {
  const weather: Tool = {
    name: "get_weather",
    description: "weather for a city",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    run: () => Promise.resolve({ ok: true, output: "18C cloudy" }),
  };
  const worker = toolWorker({
    name: "tools",
    provider: new ToolUseProvider([
      useTool("1", "get_weather", { city: "Paris" }),
      useTool("2", "done", { summary: "reported the weather" }),
    ]),
    tools: [weather],
    now: clock(),
  });
  const orch = new Orchestrator({
    workers: [worker],
    planner: fakePlanner([
      { id: "st1", description: "get the weather in Paris" },
    ]),
    router: {
      route: () => Promise.resolve({ worker: "tools", reason: "tool task" }),
    },
    now: clock(),
  });

  const result = await orch.orchestrate("weather please");
  assert.equal(result.outcome, "completed");
  assert.equal(result.verified, true);
  const res = result.ledger.evidence.find(
    (e) => e.kind === "orchestration.result",
  )!;
  const content = res.content as {
    logHead: string;
    workHead: string;
    verified: boolean;
  };
  assert.match(content.logHead, /^[0-9a-f]{64}$/, "a real log head is pinned");
  assert.match(
    content.workHead,
    /^[0-9a-f]{64}$/,
    "a real work head is pinned",
  );
  assert.equal(content.verified, true, "the sub-session itself verified");
});

test("acceptance seam pins the contract + records a verdict in the ledger", async () => {
  // The caller wires octopus-intent: a contract hash + a judge (checkContract).
  const orch = new Orchestrator({
    workers: [fakeWorker("code")],
    planner: fakePlanner([{ id: "st1", description: "fix the code" }]),
    router: keywordRouter,
    now: clock(),
    acceptance: {
      contractHash: "deadbeefcafe",
      judge: (_task, steps) =>
        Promise.resolve({
          met: steps.every((s) => s.result.outcome === "completed"),
          reason: "all subtasks completed",
        }),
    },
  });
  const result = await orch.orchestrate("ship it");
  assert.equal(result.accepted?.met, true);
  assert.equal(result.verified, true);
  const kinds = result.ledger.evidence.map((e) => e.kind);
  assert.deepEqual(kinds, [
    "orchestration.plan",
    "orchestration.contract",
    "orchestration.route",
    "orchestration.result",
    "orchestration.acceptance",
    "orchestration.done",
  ]);
  const contract = result.ledger.evidence.find(
    (e) => e.kind === "orchestration.contract",
  )!;
  assert.equal(
    (contract.content as { contractHash: string }).contractHash,
    "deadbeefcafe",
  );
});

test("LlmPlanner parses a JSON subtask list; LlmRouter parses a worker choice", async () => {
  const planner = new LlmPlanner(
    new TextProvider([
      'Here is the plan: ["read the code", "write the fix", "run tests"]',
    ]),
  );
  const subtasks = await planner.plan("fix the bug");
  assert.deepEqual(
    subtasks.map((s) => s.description),
    ["read the code", "write the fix", "run tests"],
  );

  const router = new LlmRouter(
    new TextProvider(['{"worker":"code","reason":"it edits code"}']),
  );
  const choice = await router.route("write the fix", [
    fakeWorker("code"),
    fakeWorker("tools"),
  ]);
  assert.equal(choice.worker, "code");
  assert.match(choice.reason, /edits code/);
});
