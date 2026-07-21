import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlPlaneHttpClient,
  ControlPlaneHttpError,
  ControlPlaneProtocolError,
  type AgentRun,
  type AgentExecutionState,
  type RunEvent,
} from "../src/index.js";

const RUN: AgentRun = {
  id: "run/one",
  organisationId: "org-a",
  projectId: "project-a",
  projectRef: "project://opaque/a",
  baselineRevisionRef: "git://revision/abc123",
  workItemRef: "work-item://opaque/a",
  task: "do the work",
  idempotencyKey: "builder-m3-a",
  status: "QUEUED",
  version: 1,
  attempt: 0,
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  secretRefs: [{ name: "modelApiKey", secretRef: "vault://reef/model" }],
  budget: {},
  usage: {
    tokens: 0,
    costUsd: 0,
    wallTimeMs: 0,
    toolCalls: 0,
    outputBytes: 0,
  },
  config: {},
  metadata: {},
  resultRefs: {
    diffRef: "git-diff://abc123..def456",
    testRef: "artifact://tests/junit.xml",
    evidenceRefs: ["evidence://run/one"],
  },
};

test("typed client sends tenant headers and secretRef-only credentials", async () => {
  let received:
    { readonly url: string; readonly init?: RequestInit } | undefined;
  const client = new ControlPlaneHttpClient({
    baseUrl: "https://reef.example/control/",
    tenant: { organisationId: "org-a", projectId: "project-a" },
    fetchImpl: (input, init) => {
      received = {
        url: String(input),
        ...(init !== undefined ? { init } : {}),
      };
      return Promise.resolve(jsonResponse(RUN, 202));
    },
  });
  const result = await client.createRun({
    task: "do the work",
    idempotencyKey: "builder-m3-a",
    projectRef: "project://opaque/a",
    baselineRevisionRef: "git://revision/abc123",
    secretRefs: [{ name: "modelApiKey", secretRef: "vault://reef/model" }],
  });

  assert.equal(result.id, RUN.id);
  const state: AgentExecutionState = result.status;
  assert.equal(state, "QUEUED");
  assert.equal(result.baselineRevisionRef, "git://revision/abc123");
  assert.deepEqual(result.resultRefs, RUN.resultRefs);
  assert.equal(received?.url, "https://reef.example/control/v1/runs");
  const headers = new Headers(received?.init?.headers);
  assert.equal(headers.get("x-organisation-id"), "org-a");
  assert.equal(headers.get("x-project-id"), "project-a");
  assert.equal(headers.get("idempotency-key"), "builder-m3-a");
  assert.deepEqual(JSON.parse(String(received?.init?.body)), {
    task: "do the work",
    idempotencyKey: "builder-m3-a",
    projectRef: "project://opaque/a",
    baselineRevisionRef: "git://revision/abc123",
    secretRefs: [{ name: "modelApiKey", secretRef: "vault://reef/model" }],
  });
  assert.doesNotMatch(String(received?.init?.body), /api[_-]?key\s*:/i);
});

test("resume, cancel and review commands use idempotent run endpoints", async () => {
  const calls: string[] = [];
  const keys: string[] = [];
  const client = new ControlPlaneHttpClient({
    baseUrl: "https://reef.example/",
    tenant: { organisationId: "org-a", projectId: "project-a" },
    fetchImpl: (input, init) => {
      calls.push(String(input));
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      return Promise.resolve(jsonResponse(RUN));
    },
  });

  await client.resume(RUN.id, { idempotencyKey: "resume-1" });
  await client.cancel(RUN.id, {
    idempotencyKey: "cancel-1",
    reason: "operator cancelled",
  });
  await client.pause(RUN.id, {
    idempotencyKey: "pause-1",
    actorRef: "builder-runtime",
  });
  await client.approve(RUN.id, {
    idempotencyKey: "approve-1",
    actorRef: "human://reviewer",
  });
  await client.reject(RUN.id, {
    idempotencyKey: "reject-1",
    actorRef: "human://reviewer",
    reason: "needs changes",
  });
  assert.deepEqual(
    calls.map((url) => new URL(url).pathname),
    [
      "/v1/runs/run%2Fone/resume",
      "/v1/runs/run%2Fone/cancel",
      "/v1/runs/run%2Fone/pause",
      "/v1/runs/run%2Fone/approve",
      "/v1/runs/run%2Fone/reject",
    ],
  );
  assert.deepEqual(keys, [
    "resume-1",
    "cancel-1",
    "pause-1",
    "approve-1",
    "reject-1",
  ]);
});

test("HTTP failures expose stable typed error details", async () => {
  const client = new ControlPlaneHttpClient({
    baseUrl: "https://reef.example/",
    tenant: { organisationId: "org-a", projectId: "project-a" },
    fetchImpl: () =>
      Promise.resolve(
        jsonResponse(
          { error: { code: "RUN_NOT_FOUND", message: "missing" } },
          404,
        ),
      ),
  });

  await assert.rejects(client.getRun("missing"), (error: unknown) => {
    assert.ok(error instanceof ControlPlaneHttpError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "RUN_NOT_FOUND");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("SSE reconnect resumes from an exact decimal cursor without duplicates", async () => {
  const first = runEvent("9007199254740993", "run.status_changed");
  const terminal = runEvent("9007199254740994", "run.completed");
  const requests: Array<{
    readonly url: string;
    readonly cursor: string | null;
  }> = [];
  const responses = [
    sseResponse([sse(first).slice(0, 37), sse(first).slice(37)]),
    sseResponse([sse(first), sse(terminal)]),
  ];
  const client = new ControlPlaneHttpClient({
    baseUrl: "https://reef.example/",
    tenant: { organisationId: "org-a", projectId: "project-a" },
    reconnectDelayMs: 0,
    fetchImpl: (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        cursor: headers.get("last-event-id"),
      });
      const response = responses.shift();
      assert.ok(response);
      return Promise.resolve(response);
    },
  });

  const seen: RunEvent[] = [];
  for await (const event of client.streamEvents(RUN.id)) seen.push(event);

  assert.deepEqual(
    seen.map((event) => event.cursor),
    ["9007199254740993", "9007199254740994"],
  );
  assert.equal(requests[0]?.cursor, "0");
  assert.equal(requests[1]?.cursor, "9007199254740993");
  assert.equal(
    new URL(requests[1]!.url).searchParams.get("cursor"),
    "9007199254740993",
  );
});

test("event streaming rejects non-decimal cursors before sending", async () => {
  let calls = 0;
  const client = new ControlPlaneHttpClient({
    baseUrl: "https://reef.example/",
    tenant: { organisationId: "org-a", projectId: "project-a" },
    fetchImpl: () => {
      calls++;
      return Promise.resolve(sseResponse([]));
    },
  });
  const events = client.streamEvents(RUN.id, {
    cursor: "1.5" as never,
    reconnect: false,
  });
  await assert.rejects(
    events[Symbol.asyncIterator]().next(),
    ControlPlaneProtocolError,
  );
  assert.equal(calls, 0);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function runEvent(cursor: string, type: string): RunEvent {
  return {
    id: `event-${cursor}`,
    runId: RUN.id,
    organisationId: RUN.organisationId,
    projectId: RUN.projectId,
    cursor,
    type,
    data: {},
    createdAt: "2026-07-21T00:00:00.000Z",
  };
}

function sse(event: RunEvent): string {
  return (
    `id: ${event.cursor}\n` +
    `event: ${event.type}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  );
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
