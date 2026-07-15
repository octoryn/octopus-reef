/**
 * Network-free tests for the agent worker.
 *
 * A scripted {@link ModelProvider} (no LLM, no network) drives the worker through
 * a real {@link GovernedSession}; a fake executor makes the "test" pass only after
 * the fix is written, so the loop's read → run → FIX → run → done iteration and
 * its result-feedback are exercised deterministically. The provider itself is
 * unit-tested with an injected `fetch`, and a darwin-only case proves the loop
 * applies edits + runs real commands under the OS sandbox.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernedSession,
  SandboxExecutor,
  ToolExecutor,
  reefAllowlist,
  type ActionExecutor,
  type ActionRequest,
  type ExecOutcome,
  type Tool,
} from "@octopus-reef/engine";
import {
  AgentWorker,
  AnthropicProvider,
  BedrockProvider,
  ProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type ModelProvider,
  type ToolUseBlock,
} from "../src/index.js";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 8, 0, 0, n++)).toISOString();
}

/** A provider that replays a fixed script of responses and records its inputs. */
class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  #queue: CompletionResponse[];
  constructor(queue: CompletionResponse[]) {
    this.#queue = [...queue];
  }
  complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const next = this.#queue.shift();
    if (next === undefined) throw new Error("script exhausted");
    return Promise.resolve(next);
  }
}

const use = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  usage?: CompletionResponse["usage"],
): CompletionResponse => ({
  content: [{ type: "tool_use", id, name, input } as ToolUseBlock],
  stopReason: "tool_use",
  ...(usage !== undefined ? { usage } : {}),
});

/** A fake executor whose "npm test" passes only once sum.js has been fixed. */
class FakeExecutor implements ActionExecutor {
  readonly name = "fake";
  readonly actions: ActionRequest[] = [];
  #fixed = false;
  execute(action: ActionRequest): Promise<ExecOutcome> {
    this.actions.push(action);
    if (action.type === "read") {
      return Promise.resolve({
        ok: true,
        output: this.#fixed ? "(a, b) => a + b" : "(a, b) => a - b",
      });
    }
    if (action.type === "edit") {
      const content = String(
        (action.payload as { content?: unknown } | undefined)?.content ?? "",
      );
      if (content.includes("a + b")) this.#fixed = true;
      return Promise.resolve({ ok: true, output: "wrote" });
    }
    if (action.type === "command") {
      return Promise.resolve(
        this.#fixed
          ? { ok: true, output: "PASS", exitCode: 0 }
          : { ok: false, error: "FAIL: sum(2,3) = -1", exitCode: 1 },
      );
    }
    return Promise.resolve({ ok: false, error: "unsupported" });
  }
}

test("worker drives read → run(fail) → fix → run(pass) → done, feeding results back", async () => {
  const provider = new ScriptedProvider([
    use(
      "1",
      "read_file",
      { path: "sum.js" },
      {
        provider: "anthropic",
        model: "claude-test",
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
    ),
    use("2", "run_command", { command: "npm test" }), // fails first
    use("3", "write_file", {
      path: "sum.js",
      content: "module.exports = (a, b) => a + b;",
    }),
    use("4", "run_command", { command: "npm test" }), // now passes
    use("5", "done", { summary: "fixed the sum bug; tests pass" }),
  ]);
  const executor = new FakeExecutor();
  const session = new GovernedSession({
    id: "t1",
    task: "fix the failing test",
    driver: new AgentWorker({ provider }),
    authorizer: reefAllowlist({ commands: { npm: ["test"] } }),
    executor,
    now: clock(),
  });

  const { outcome } = await session.run();
  assert.equal(outcome, "completed");
  assert.equal(session.verify().ok, true, "the governed session verifies");
  const usageEvent = session.events.find((event) =>
    event.summary.startsWith("model usage:"),
  );
  assert.equal(
    (usageEvent?.data.modelUsage as { totalTokens?: number } | undefined)
      ?.totalTokens,
    18,
    "token usage from the provider response is persisted as evidence",
  );
  assert.deepEqual(
    executor.actions.map((a) => a.type),
    ["read", "command", "edit", "command"],
    "the loop iterated: read, failing test, fix, passing test",
  );
  const fedBack = provider.requests.some((r) =>
    JSON.stringify(r.messages).includes("FAILED"),
  );
  assert.ok(fedBack, "the failing test result was fed back to the model");
});

const lookupTool: Tool = {
  name: "lookup",
  description: "look up a fact",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  },
  run: (input) =>
    Promise.resolve({
      ok: true,
      output: `answer for ${String((input as { q?: unknown }).q)}`,
    }),
};

test("worker calls a governed non-code tool (MCP/API) and feeds the result back", async () => {
  const provider = new ScriptedProvider([
    use("1", "lookup", { q: "capital of france" }),
    use("2", "done", { summary: "looked it up" }),
  ]);
  const session = new GovernedSession({
    id: "tool1",
    task: "look something up",
    driver: new AgentWorker({
      provider,
      tools: [
        {
          name: "lookup",
          description: "look up a fact",
          inputSchema: lookupTool.inputSchema,
        },
      ],
    }),
    authorizer: reefAllowlist({ tools: ["lookup"] }),
    executor: new ToolExecutor([lookupTool]),
    now: clock(),
  });
  const { outcome } = await session.run();
  assert.equal(outcome, "completed");
  assert.equal(session.verify().ok, true, "the tool session is provable");
  const fedBack = provider.requests.some((r) =>
    JSON.stringify(r.messages).includes("answer for capital of france"),
  );
  assert.ok(fedBack, "the tool output was fed back to the model");
});

test("an un-allowlisted tool is denied by governance", async () => {
  const provider = new ScriptedProvider([
    use("1", "lookup", { q: "x" }),
    use("2", "fail", { summary: "blocked" }),
  ]);
  const session = new GovernedSession({
    id: "tool2",
    task: "call a forbidden tool",
    driver: new AgentWorker({
      provider,
      tools: [
        {
          name: "lookup",
          description: "look up a fact",
          inputSchema: { type: "object" },
        },
      ],
    }),
    authorizer: reefAllowlist({ tools: [] }), // no tools permitted
    executor: new ToolExecutor([lookupTool]),
    now: clock(),
  });
  await session.run();
  assert.equal(session.verify().ok, true);
  const toldDenied = provider.requests.some((r) =>
    JSON.stringify(r.messages).includes("DENIED"),
  );
  assert.ok(
    toldDenied,
    "the allowlist blocked the tool and the agent was told",
  );
});

test("worker fails cleanly when the model calls fail", async () => {
  const provider = new ScriptedProvider([
    use("1", "fail", { summary: "the task is impossible" }),
  ]);
  const session = new GovernedSession({
    id: "t2",
    task: "do the impossible",
    driver: new AgentWorker({ provider }),
    authorizer: reefAllowlist(),
    executor: new FakeExecutor(),
    now: clock(),
  });
  const { outcome } = await session.run();
  assert.equal(outcome, "failed");
  assert.equal(session.verify().ok, true, "even a failed session is provable");
});

test("worker stops (fails) at the turn cap without a passing test", async () => {
  // A provider that always just reads — never calls done — must be bounded.
  const looping: ModelProvider = {
    name: "looping",
    complete: () => Promise.resolve(use("x", "read_file", { path: "a" })),
  };
  const session = new GovernedSession({
    id: "t3",
    task: "loop forever",
    driver: new AgentWorker({ provider: looping, maxTurns: 3 }),
    authorizer: reefAllowlist(),
    executor: new FakeExecutor(),
    now: clock(),
  });
  const { outcome } = await session.run();
  assert.equal(outcome, "failed");
});

test("BedrockProvider builds an Anthropic-on-Bedrock request and parses tool_use (injected fetch)", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "tool_use",
            id: "tu",
            name: "read_file",
            input: { path: "x" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 5 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const provider = new BedrockProvider({
    token: "tok",
    region: "us-west-2",
    fetchImpl: fakeFetch,
  });
  const resp = await provider.complete({
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "read_file", description: "d", inputSchema: { type: "object" } },
    ],
    maxTokens: 100,
  });

  assert.equal(resp.stopReason, "tool_use");
  assert.equal(resp.content[0]?.type, "tool_use");
  assert.equal(resp.usage?.totalTokens, 8);
  assert.match(
    String(captured?.url),
    /bedrock-runtime\.us-west-2\.amazonaws\.com\/model\//,
  );
  const headers = captured?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  const body = JSON.parse(String(captured?.init.body)) as {
    anthropic_version: string;
    tools: Array<{ input_schema: unknown }>;
  };
  assert.equal(body.anthropic_version, "bedrock-2023-05-31");
  assert.deepEqual(body.tools[0]?.input_schema, { type: "object" });
});

test("AnthropicProvider builds a Messages request and normalizes token usage (injected fetch)", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "tool_use",
            id: "tu",
            name: "write_file",
            input: { path: "x", content: "ok" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 13,
          output_tokens: 17,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    model: "claude-test",
    fetchImpl: fakeFetch,
  });
  const resp = await provider.complete({
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "write_file", description: "d", inputSchema: { type: "object" } },
    ],
    maxTokens: 100,
  });

  assert.equal(captured?.url, "https://api.anthropic.com/v1/messages");
  const headers = captured?.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(resp.content[0]?.type, "tool_use");
  assert.equal(resp.usage?.provider, "anthropic");
  assert.equal(resp.usage?.model, "claude-test");
  assert.equal(resp.usage?.totalTokens, 35);
});

test("BedrockProvider retries on 429 then succeeds", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return calls < 3
      ? new Response("busy", { status: 429 })
      : new Response(
          JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
  }) as unknown as typeof fetch;
  const provider = new BedrockProvider({
    token: "t",
    fetchImpl: fakeFetch,
    sleep: () => Promise.resolve(),
    maxRetries: 5,
  });
  const resp = await provider.complete({
    system: "",
    messages: [],
    tools: [],
    maxTokens: 10,
  });
  assert.equal(calls, 3);
  assert.equal(resp.content[0]?.type, "text");
});

test("BedrockProvider fails closed without a token", async () => {
  const provider = new BedrockProvider({
    fetchImpl: (() => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      provider.complete({ system: "", messages: [], tools: [], maxTokens: 1 }),
    ProviderError,
  );
});

test(
  "INTEGRATION: worker applies a real edit + runs a real test under the OS sandbox",
  { skip: process.platform !== "darwin" ? "darwin-only (OS sandbox)" : false },
  async () => {
    const ws = mkdtempSync(join(tmpdir(), "octopus-agent-"));
    try {
      writeFileSync(
        join(ws, "package.json"),
        JSON.stringify({
          name: "t",
          version: "1.0.0",
          scripts: { test: "node test.js" },
        }),
      );
      writeFileSync(join(ws, "sum.js"), "module.exports = (a, b) => a - b;\n"); // bug
      writeFileSync(
        join(ws, "test.js"),
        "const s=require('./sum');if(s(2,3)!==5){process.exit(1)}console.log('PASS');\n",
      );

      const provider = new ScriptedProvider([
        use("1", "read_file", { path: "sum.js" }),
        use("2", "write_file", {
          path: "sum.js",
          content: "module.exports = (a, b) => a + b;\n",
        }),
        use("3", "run_command", { command: "npm test" }),
        use("4", "done", { summary: "fixed" }),
      ]);
      const session = new GovernedSession({
        id: "int1",
        task: "fix the failing test",
        driver: new AgentWorker({ provider }),
        authorizer: reefAllowlist({ commands: { npm: ["test"], node: "*" } }),
        executor: new SandboxExecutor(ws, { timeoutMs: 20_000 }),
        now: clock(),
      });
      const { outcome } = await session.run();
      assert.equal(outcome, "completed");
      assert.equal(session.verify().ok, true);
      assert.match(
        readFileSync(join(ws, "sum.js"), "utf8"),
        /a \+ b/,
        "the file was really fixed",
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  },
);
