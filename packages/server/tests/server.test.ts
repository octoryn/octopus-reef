/**
 * M2: the server daemon. Real HTTP requests against a server on an ephemeral
 * port prove the acceptance — two independent clients observe one live session
 * and both verify it store-untrusting over the wire.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorker, type ModelProvider } from "@octopus-reef/agent";
import { WorkspaceExecutor, reefAllowlist } from "@octopus-reef/engine";
import { ReefServer } from "../src/index.js";
import type { ServerEvent } from "@octopus-reef/protocol";

/** GET raw text (not JSON) — for static assets. */
function getText(
  port: number,
  path: string,
): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"] ?? ""),
            body: raw,
          }),
        );
      })
      .on("error", reject);
  });
}

// Loose response shape — test ergonomics over precise typing of every route.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers:
          data === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json: unknown = undefined;
          try {
            json = raw === "" ? undefined : JSON.parse(raw);
          } catch {
            json = raw;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** Read an SSE stream to completion, returning its parsed frames. */
function collectSSE(port: number, path: string): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const frames: ServerEvent[] = [];
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let buf = "";
      res.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const line = buf
            .slice(0, idx)
            .split("\n")
            .find((l) => l.startsWith("data: "));
          buf = buf.slice(idx + 2);
          if (line !== undefined) frames.push(JSON.parse(line.slice(6)));
        }
      });
      res.on("end", () => resolve(frames));
    });
    req.on("error", reject);
  });
}

test("M2: two clients observe one live session and both verify it", async () => {
  const server = new ReefServer();
  const port = await server.listen(0);
  try {
    const created = await request(port, "POST", "/sessions", {
      task: "add rate limiting",
    });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    assert.match(id, /^sess-/);

    // Two independent subscribers to the same session.
    const [a, b] = await Promise.all([
      collectSSE(port, `/sessions/${id}/events`),
      collectSSE(port, `/sessions/${id}/events`),
    ]);

    for (const frames of [a, b]) {
      assert.equal(frames[0]?.type, "hello");
      assert.ok(
        frames.some((f) => f.type === "event"),
        "the stream carried evidence events",
      );
      const last = frames.at(-1);
      assert.equal(last?.type, "sealed");
      if (last?.type === "sealed") {
        assert.equal(last.verify.ok, true);
        assert.equal(last.verify.binding, "bound");
        assert.ok(last.snapshot.sealed);
      }
    }
    // Both observers saw the same evidence stream.
    const evA = a.filter((f) => f.type === "event").length;
    const evB = b.filter((f) => f.type === "event").length;
    assert.equal(evA, evB);
    assert.ok(evA > 0);

    // Store-untrusting verification over the wire.
    const verify = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(verify.status, 200);
    assert.equal(verify.json.ok, true);
    assert.equal(verify.json.work, "intact");
    assert.equal(verify.json.log, "intact");

    // The point-in-time view reflects a sealed, verified session.
    const view = await request(port, "GET", `/sessions/${id}`);
    assert.equal(view.status, 200);
    assert.equal(view.json.status, "sealed");
    assert.equal(view.json.outcome, "completed");
    assert.ok(view.json.snapshot);
    assert.equal(view.json.verify.ok, true);
  } finally {
    await server.close();
  }
});

test("M2: a keyed session verifies with the same secret over the wire", async () => {
  const server = new ReefServer();
  const port = await server.listen(0);
  try {
    const created = await request(port, "POST", "/sessions", {
      task: "keyed run",
      secret: "s3cr3t",
    });
    const id = created.json.id as string;
    const frames = await collectSSE(port, `/sessions/${id}/events`);
    const sealed = frames.at(-1);
    assert.equal(sealed?.type, "sealed");
    if (sealed?.type === "sealed") assert.equal(sealed.verify.ok, true);
  } finally {
    await server.close();
  }
});

test("M3: persisted verify turns red after one evidence-log byte is flipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-m3-persist-"));
  const server = new ReefServer({ persistDir: dir });
  const port = await server.listen(0);
  try {
    const created = await request(port, "POST", "/sessions", {
      task: "offline keyless demo",
      persist: true,
    });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    await collectSSE(port, `/sessions/${id}/events`);

    const before = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);

    const logPath = join(dir, id, "session.log.jsonl");
    const raw = readFileSync(logPath);
    const offset = raw.indexOf(Buffer.from("offline"));
    assert.ok(offset >= 0, "test fixture should contain a flippable byte");
    raw[offset] = raw[offset] === 0x6f ? 0x70 : 0x6f;
    writeFileSync(logPath, raw);

    const after = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(after.status, 200);
    assert.equal(after.json.ok, false);
    assert.match(after.json.log, /broken/i);
  } finally {
    await server.close();
  }
});

test("N1: server can run a real governed edit driver when BYOK runtime is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-n1-real-"));
  const provider: ModelProvider = {
    name: "scripted-real",
    complete: (() => {
      let turn = 0;
      return () => {
        turn++;
        return Promise.resolve(
          turn === 1
            ? {
                content: [
                  {
                    type: "tool_use",
                    id: "w1",
                    name: "write_file",
                    input: {
                      path: "n1.txt",
                      content: "real edit made by governed N1 driver\n",
                    },
                  },
                ],
                stopReason: "tool_use",
                usage: {
                  provider: "anthropic",
                  model: "claude-test",
                  inputTokens: 5,
                  outputTokens: 7,
                  totalTokens: 12,
                },
              }
            : {
                content: [
                  {
                    type: "tool_use",
                    id: "d1",
                    name: "done",
                    input: { summary: "edited n1.txt" },
                  },
                ],
                stopReason: "tool_use",
              },
        );
      };
    })(),
  };
  const server = new ReefServer({
    driverFactory: ({ workspaceRoot }) => ({
      driver: new AgentWorker({ provider, maxTurns: 4 }),
      authorizer: reefAllowlist(),
      executor: new WorkspaceExecutor(workspaceRoot ?? dir),
    }),
  });
  const port = await server.listen(0);
  try {
    const created = await request(port, "POST", "/sessions", {
      task: "write n1.txt",
      workspaceRoot: dir,
    });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    const frames = await collectSSE(port, `/sessions/${id}/events`);
    const sealed = frames.at(-1);
    assert.equal(sealed?.type, "sealed");
    if (sealed?.type === "sealed") assert.equal(sealed.verify.ok, true);
    assert.match(readFileSync(join(dir, "n1.txt"), "utf8"), /real edit/);
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (frame.event.data.modelUsage as { totalTokens?: number } | undefined)
            ?.totalTokens === 12,
      ),
      "model token usage is persisted into the evidence stream",
    );
  } finally {
    await server.close();
  }
});

test("N5: installs an MCP power, records a governed tool call, and denies an unallowlisted tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-n5-mcp-"));
  const server = new ReefServer({ persistDir: dir });
  const port = await server.listen(0);
  try {
    const initialPowers = await request(port, "GET", "/powers");
    assert.equal(initialPowers.status, 200);
    assert.equal(initialPowers.json.installed.length, 0);
    assert.ok(
      initialPowers.json.available.some(
        (power: { id: string }) => power.id === "reef-echo",
      ),
    );

    const installed = await request(port, "POST", "/powers/install", {
      id: "reef-echo",
    });
    assert.equal(installed.status, 201);
    assert.equal(installed.json.installed.id, "reef-echo");

    const powers = await request(port, "GET", "/powers");
    assert.equal(powers.status, 200);
    assert.equal(powers.json.installed.length, 1);
    assert.equal(powers.json.installed[0].id, "reef-echo");
    assert.deepEqual(powers.json.installed[0].allowedTools, ["echo"]);

    const created = await request(port, "POST", "/sessions", {
      task: "N5 MCP allowed call",
      persist: true,
      mcp: {
        serverId: "reef-echo",
        tool: "echo",
        input: { text: "offline" },
      },
    });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    const frames = await collectSSE(port, `/sessions/${id}/events`);
    const executed = frames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "action.executed" &&
        frame.event.summary.includes("reef-echo.echo"),
    );
    assert.ok(executed, "MCP call should be an evidence-linked action");
    if (executed?.type === "event") {
      assert.match(executed.event.evidenceId, /^ev_[a-f0-9]{64}$/);
      assert.equal(
        (executed.event.data.payload as { tool?: string }).tool,
        "reef-echo.echo",
      );
      assert.equal(
        (
          executed.event.data.result as {
            output?: { bytes?: number; sha256?: string };
          }
        ).output?.bytes,
        "echo:offline".length,
      );
    }

    const before = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);

    const logPath = join(dir, id, "session.log.jsonl");
    const raw = readFileSync(logPath);
    const offset = raw.indexOf(Buffer.from("reef-echo.echo"));
    assert.ok(offset >= 0, "evidence log should name the MCP tool");
    raw[offset] = raw[offset] === 0x72 ? 0x73 : 0x72;
    writeFileSync(logPath, raw);

    const after = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(after.status, 200);
    assert.equal(after.json.ok, false);
    assert.match(after.json.log, /broken/i);

    const deniedCreated = await request(port, "POST", "/sessions", {
      task: "N5 MCP deny unallowlisted reverse",
      persist: true,
      mcp: {
        serverId: "reef-echo",
        tool: "reverse",
        input: { text: "offline" },
        expectDenied: true,
      },
    });
    assert.equal(deniedCreated.status, 201);
    const deniedId = deniedCreated.json.id as string;
    const deniedFrames = await collectSSE(port, `/sessions/${deniedId}/events`);
    const denied = deniedFrames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "action.denied" &&
        frame.event.summary.includes("reef-echo.reverse"),
    );
    assert.ok(denied, "unallowlisted MCP tool should be denied as evidence");
    if (denied?.type === "event") {
      assert.equal(denied.event.data.stage, "authorize");
      assert.equal(denied.event.data.resource, "reef-echo.reverse");
    }
    const deniedVerify = await request(
      port,
      "GET",
      `/sessions/${deniedId}/verify`,
    );
    assert.equal(deniedVerify.status, 200);
    assert.equal(deniedVerify.json.ok, true);
  } finally {
    await server.close();
  }
});

test("N6: usage endpoint aggregates persisted provider usage and labelled cost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-n6-usage-"));
  const provider: ModelProvider = {
    name: "scripted-usage",
    complete: () =>
      Promise.resolve({
        content: [
          {
            type: "tool_use",
            id: "d1",
            name: "done",
            input: { summary: "usage recorded" },
          },
        ],
        stopReason: "tool_use",
        usage: {
          provider: "anthropic",
          model: "claude-test",
          inputTokens: 1000,
          outputTokens: 2000,
          totalTokens: 3000,
        },
      }),
  };
  const writingServer = new ReefServer({
    persistDir: dir,
    driverFactory: () => ({
      driver: new AgentWorker({ provider, maxTurns: 2 }),
      authorizer: reefAllowlist(),
      executor: new WorkspaceExecutor(dir),
    }),
  });
  const writingPort = await writingServer.listen(0);
  try {
    const created = await request(writingPort, "POST", "/sessions", {
      task: "N6 provider usage aggregation",
      persist: true,
    });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    const frames = await collectSSE(writingPort, `/sessions/${id}/events`);
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (frame.event.data.modelUsage as { totalTokens?: number } | undefined)
            ?.totalTokens === 3000,
      ),
      "provider usage should be persisted as evidence",
    );
  } finally {
    await writingServer.close();
  }

  const readingServer = new ReefServer({ persistDir: dir });
  const readingPort = await readingServer.listen(0);
  try {
    const usage = await request(readingPort, "GET", "/usage");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.totals.calls, 1);
    assert.equal(usage.json.totals.inputTokens, 1000);
    assert.equal(usage.json.totals.outputTokens, 2000);
    assert.equal(usage.json.totals.totalTokens, 3000);
    assert.equal(usage.json.totals.costUsd, 0.007);
    assert.equal(usage.json.sessions.length, 1);
    assert.equal(usage.json.sessions[0].totals.costUsd, 0.007);
    assert.equal(usage.json.byModel[0].provider, "anthropic");
    assert.equal(usage.json.byModel[0].model, "claude-test");
    assert.equal(usage.json.byModel[0].priceStatus, "priced");
    assert.match(
      usage.json.byModel[0].costSource,
      /injected-provider test price table/,
    );
    assert.deepEqual(
      usage.json.remaining.map((entry: { provider: string; status: string }) => [
        entry.provider,
        entry.status,
      ]),
      [
        ["anthropic", "pending-key"],
        ["bedrock", "not-available"],
      ],
    );
  } finally {
    await readingServer.close();
  }
});

test("N3: active steering is evidence-pinned, changes mock behavior, and detects tamper", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-n3-steering-"));
  const server = new ReefServer({ persistDir: dir });
  const port = await server.listen(0);
  try {
    const initial = await request(port, "GET", "/steering");
    assert.equal(initial.status, 200);
    assert.ok(
      initial.json.available.some(
        (item: { id: string; kind: string }) =>
          item.id === "bug-fix" && item.kind === "skill",
      ),
      "built-in steering skills should be selectable",
    );

    const custom = await request(port, "POST", "/steering/custom", {
      title: "N3 custom quick spec",
      kind: "doc",
      content: "Use the N3 custom steering doc to shape the mock run.",
      mockEffect: "N3 custom steering changed the mock session.",
    });
    assert.equal(custom.status, 201);
    const customId = custom.json.steering.id as string;
    assert.equal(custom.json.steering.kind, "doc");
    assert.match(custom.json.steering.contentSha256, /^[a-f0-9]{64}$/);

    const active = await request(port, "POST", "/steering/active", {
      activeIds: [customId],
    });
    assert.equal(active.status, 200);
    assert.deepEqual(active.json.activeIds, [customId]);

    const created = await request(port, "POST", "/sessions", {
      task: "N3 steered mock session",
      persist: true,
    });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    const frames = await collectSSE(port, `/sessions/${id}/events`);
    const applied = frames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "observation" &&
        Array.isArray(
          (
            frame.event.data.steeringSet as
              | { active?: unknown }
              | undefined
          )?.active,
        ),
    );
    assert.ok(applied, "active steering set should be pinned into evidence");
    if (applied?.type === "event") {
      assert.match(applied.event.evidenceId, /^ev_[a-f0-9]{64}$/);
      const pinned = (
        applied.event.data.steeringSet as {
          active: Array<{ id: string; contentSha256: string }>;
        }
      ).active[0];
      assert.equal(pinned?.id, customId);
      assert.match(pinned?.contentSha256 ?? "", /^[a-f0-9]{64}$/);
    }
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "message" &&
          frame.event.summary === "N3 custom steering changed the mock session.",
      ),
      "steering doc should change the mock session behavior",
    );

    const before = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);

    const logPath = join(dir, id, "session.log.jsonl");
    const raw = readFileSync(logPath);
    const offset = raw.indexOf(Buffer.from("N3 custom steering"));
    assert.ok(offset >= 0, "steering evidence should contain a flippable byte");
    raw[offset] = raw[offset] === 0x4e ? 0x4f : 0x4e;
    writeFileSync(logPath, raw);

    const after = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(after.status, 200);
    assert.equal(after.json.ok, false);
    assert.match(after.json.log, /broken/i);
  } finally {
    await server.close();
  }
});

test("N4: firing a hook creates a governed session and detects evidence tamper", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-n4-hooks-"));
  const server = new ReefServer({ persistDir: dir });
  const port = await server.listen(0);
  try {
    const createdHook = await request(port, "POST", "/hooks", {
      name: "N4 on-save verifier",
      trigger: "on-save",
      task: "N4 hook governed mock session",
    });
    assert.equal(createdHook.status, 201);
    const hook = createdHook.json.hook;
    assert.match(hook.id, /^hook-/);
    assert.equal(hook.trigger, "on-save");

    const listed = await request(port, "GET", "/hooks");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.hooks.length, 1);

    const fired = await request(port, "POST", `/hooks/${hook.id}/fire`, {
      event: { path: "src/n4.ts", reason: "manual verifier fire" },
    });
    assert.equal(fired.status, 201);
    assert.equal(fired.json.hook.id, hook.id);
    const sessionId = fired.json.sessionId as string;
    assert.match(sessionId, /^sess-/);

    const frames = await collectSSE(port, `/sessions/${sessionId}/events`);
    const hookEvidence = frames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "observation" &&
        (frame.event.data.hook as { id?: string } | undefined)?.id === hook.id,
    );
    assert.ok(hookEvidence, "hook fire should be recorded as evidence");
    if (hookEvidence?.type === "event") {
      assert.match(hookEvidence.event.evidenceId, /^ev_[a-f0-9]{64}$/);
      const data = hookEvidence.event.data.hook as {
        trigger?: string;
        event?: { path?: string };
      };
      assert.equal(data.trigger, "on-save");
      assert.equal(data.event?.path, "src/n4.ts");
    }

    const before = await request(port, "GET", `/sessions/${sessionId}/verify`);
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);

    const logPath = join(dir, sessionId, "session.log.jsonl");
    const raw = readFileSync(logPath);
    const offset = raw.indexOf(Buffer.from("N4 on-save verifier"));
    assert.ok(offset >= 0, "hook evidence should contain a flippable byte");
    raw[offset] = raw[offset] === 0x4e ? 0x4f : 0x4e;
    writeFileSync(logPath, raw);

    const after = await request(port, "GET", `/sessions/${sessionId}/verify`);
    assert.equal(after.status, 200);
    assert.equal(after.json.ok, false);
    assert.match(after.json.log, /broken/i);
  } finally {
    await server.close();
  }
});

test("N2: creates a spec, advances workstate through governance, rejects illegal moves, and detects tamper", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-n2-specs-"));
  const server = new ReefServer({ persistDir: dir });
  const port = await server.listen(0);
  try {
    const created = await request(port, "POST", "/specs", {
      title: "N2 governed spec",
      tasks: ["Draft spec", "Implement spec"],
    });
    assert.equal(created.status, 201);
    const spec = created.json.spec;
    assert.match(spec.id, /^spec-/);
    assert.equal(spec.tasks.length, 2);
    assert.equal(spec.tasks[0].state, "proposed");
    assert.equal(spec.tasks[0].history[0].to, "proposed");
    assert.match(spec.tasks[0].history[0].evidenceId, /^ev_[a-f0-9]{64}$/);

    const itemId = spec.tasks[0].id as string;
    const advanced = await request(port, "POST", "/sessions", {
      task: "N2 governed spec advance",
      persist: true,
      spec: {
        specId: spec.id,
        itemId,
        to: "ready",
        reason: "legal N2 transition",
      },
    });
    assert.equal(advanced.status, 201);
    const sessionId = advanced.json.id as string;
    const frames = await collectSSE(port, `/sessions/${sessionId}/events`);
    const action = frames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "action.executed" &&
        frame.event.summary.includes("Spec transition"),
    );
    assert.ok(action, "spec transition should run through a governed tool action");
    const observed = frames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "observation" &&
        typeof frame.event.data.transitionEvidenceId === "string",
    );
    assert.ok(observed, "session should observe the spec transition evidence id");

    const view = await request(port, "GET", `/specs/${spec.id}`);
    assert.equal(view.status, 200);
    assert.equal(view.json.tasks[0].state, "ready");
    const transition = view.json.transitions.find(
      (candidate: { itemId: string; from: string | null; to: string }) =>
        candidate.itemId === itemId &&
        candidate.from === "proposed" &&
        candidate.to === "ready",
    );
    assert.ok(transition, "legal transition should be in workstate history");
    assert.match(transition.evidenceId, /^ev_[a-f0-9]{64}$/);

    const illegal = await request(port, "POST", `/specs/${spec.id}/advance`, {
      itemId,
      to: "in_progress",
      reason: "skip claim illegally",
    });
    assert.equal(illegal.status, 400);
    assert.match(illegal.json.error, /illegal transition/i);

    const before = await request(port, "GET", `/specs/${spec.id}/verify`);
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);
    assert.equal(before.json.work, "intact");

    const workPath = join(dir, "specs", spec.id, "workstate.jsonl");
    const raw = readFileSync(workPath);
    const offset = raw.indexOf(Buffer.from("ready"));
    assert.ok(offset >= 0, "workstate trail should contain a flippable transition byte");
    raw[offset] = raw[offset] === 0x72 ? 0x73 : 0x72;
    writeFileSync(workPath, raw);

    const after = await request(port, "GET", `/specs/${spec.id}/verify`);
    assert.equal(after.status, 200);
    assert.equal(after.json.ok, false);
    assert.match(after.json.work, /broken/i);
  } finally {
    await server.close();
  }
});

test("M5: serves the web SPA for non-API routes, confined, API still works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-static-"));
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><title>reef</title>APP",
  );
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('reef')");

  const server = new ReefServer({ staticDir: dir });
  const port = await server.listen(0);
  try {
    // root → index.html
    const root = await getText(port, "/");
    assert.equal(root.status, 200);
    assert.match(root.type, /text\/html/);
    assert.match(root.body, /APP/);

    // a real asset with the right content-type
    const asset = await getText(port, "/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.type, /javascript/);
    assert.match(asset.body, /reef/);

    // an unknown client route → SPA fallback (index.html)
    const spa = await getText(port, "/sessions-view/abc");
    assert.match(spa.body, /APP/);

    // path traversal is confined — never serves outside the static root
    const escape = await getText(port, "/../../../../etc/passwd");
    assert.ok(!escape.body.includes("root:"), "must not leak /etc/passwd");

    // the API still works alongside static serving
    const created = await request(port, "POST", "/sessions", { task: "t" });
    assert.equal(created.status, 201);
  } finally {
    await server.close();
  }
});

test("surface review: sessions are evicted at capacity (bounded memory)", async () => {
  // maxSessions=2: after three sealed sessions, the oldest is evicted.
  const server = new ReefServer({ maxSessions: 2 });
  const port = await server.listen(0);
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await request(port, "POST", "/sessions", {
        task: `t${i}`,
      });
      assert.equal(created.status, 201);
      // wait for it to seal (so the next create sees it as evictable)
      await collectSSE(port, `/sessions/${created.json.id}/events`);
      ids.push(created.json.id as string);
    }
    // the oldest is gone; the two most recent remain
    assert.equal(
      (await request(port, "GET", `/sessions/${ids[0]}`)).status,
      404,
    );
    assert.equal(
      (await request(port, "GET", `/sessions/${ids[1]}`)).status,
      200,
    );
    assert.equal(
      (await request(port, "GET", `/sessions/${ids[2]}`)).status,
      200,
    );
  } finally {
    await server.close();
  }
});

test("M2: health, unknown session, and bad requests", async () => {
  const server = new ReefServer();
  const port = await server.listen(0);
  try {
    assert.equal((await request(port, "GET", "/health")).json.ok, true);
    assert.equal((await request(port, "GET", "/sessions/nope")).status, 404);
    assert.equal(
      (await request(port, "GET", "/sessions/nope/verify")).status,
      404,
    );
    const noTask = await request(port, "POST", "/sessions", { task: "  " });
    assert.equal(noTask.status, 400);
    assert.equal((await request(port, "GET", "/nowhere")).status, 404);
  } finally {
    await server.close();
  }
});
