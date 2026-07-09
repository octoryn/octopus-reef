/**
 * M2: the server daemon. Real HTTP requests against a server on an ephemeral
 * port prove the acceptance — two independent clients observe one live session
 * and both verify it store-untrusting over the wire.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorker, type ModelProvider } from "@octopus-reef/agent";
import { TEST_GATEWAY_LICENSE_TOKEN } from "@octopus-reef/commercial";
import { startStubGateway } from "@octopus-reef/commercial/stub";
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

function chromeAvailable(): boolean {
  if (process.env.CHROME_PATH !== undefined) {
    return existsSync(process.env.CHROME_PATH);
  }
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ].some((candidate) => existsSync(candidate));
}

async function startLocalPage(html: string): Promise<{
  readonly url: string;
  close(): Promise<void>;
}> {
  const page = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    page.once("error", reject);
    page.listen(0, "127.0.0.1", () => resolve());
  });
  const address = page.address();
  assert.ok(
    typeof address === "object" && address !== null,
    "local test page should bind to a TCP port",
  );
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        page.close((err) => (err ? reject(err) : resolve()));
      }),
  };
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

test(
  "N11: browser Power records governed CDP reads and denied unallowlisted tool",
  { skip: chromeAvailable() ? false : "Google Chrome is not available" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "reef-n11-browser-"));
    const page = await startLocalPage(`<!doctype html>
<html>
  <head><title>Reef Browser Test</title></head>
  <body>
    <main id="target">
      <h1>Reef Browser Test</h1>
      <p>DOM evidence is local and governed.</p>
    </main>
  </body>
</html>`);
    const server = new ReefServer({ persistDir: dir });
    const port = await server.listen(0);
    try {
      const created = await request(port, "POST", "/sessions", {
        task: "N11 governed browser read",
        persist: true,
        browser: { url: page.url, selector: "#target" },
      });
      assert.equal(created.status, 201);
      const id = created.json.id as string;
      const frames = await collectSSE(port, `/sessions/${id}/events`);
      const tools = frames
        .filter(
          (frame) =>
            frame.type === "event" &&
            frame.event.kind === "action.executed" &&
            frame.event.data.actionType === "tool",
        )
        .map((frame) =>
          frame.type === "event"
            ? (frame.event.data.payload as { tool?: string } | undefined)?.tool
            : undefined,
        );
      assert.deepEqual(tools, [
        "browser.navigate",
        "browser.getDom",
        "browser.getContent",
        "browser.screenshot",
      ]);
      for (const frame of frames) {
        if (
          frame.type === "event" &&
          frame.event.kind === "action.executed" &&
          frame.event.summary.includes("Browser tool call:")
        ) {
          assert.match(frame.event.evidenceId, /^ev_[a-f0-9]{64}$/);
          assert.equal(frame.event.data.executor, "tool");
          assert.equal(frame.event.data.ok, true);
          assert.ok(
            (
              frame.event.data.result as {
                output?: { bytes?: number; sha256?: string };
              }
            ).output?.bytes,
          );
        }
      }

      const before = await request(port, "GET", `/sessions/${id}/verify`);
      assert.equal(before.status, 200);
      assert.equal(before.json.ok, true);

      const logPath = join(dir, id, "session.log.jsonl");
      const raw = readFileSync(logPath);
      const offset = raw.indexOf(Buffer.from("browser.getDom"));
      assert.ok(
        offset >= 0,
        "browser evidence should contain a flippable byte",
      );
      raw[offset] = raw[offset] === 0x62 ? 0x63 : 0x62;
      writeFileSync(logPath, raw);

      const after = await request(port, "GET", `/sessions/${id}/verify`);
      assert.equal(after.status, 200);
      assert.equal(after.json.ok, false);
      assert.match(after.json.log, /broken/i);

      const deniedCreated = await request(port, "POST", "/sessions", {
        task: "N11 browser deny unallowlisted screenshot",
        persist: true,
        browser: {
          url: page.url,
          tool: "browser.screenshot",
          expectDenied: true,
        },
      });
      assert.equal(deniedCreated.status, 201);
      const deniedId = deniedCreated.json.id as string;
      const deniedFrames = await collectSSE(
        port,
        `/sessions/${deniedId}/events`,
      );
      const denied = deniedFrames.find(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "action.denied" &&
          frame.event.summary.includes("browser.screenshot"),
      );
      assert.ok(denied, "unallowlisted browser tool should be denied");
      if (denied?.type === "event") {
        assert.equal(denied.event.data.stage, "authorize");
        assert.equal(denied.event.data.resource, "browser.screenshot");
        assert.match(denied.event.evidenceId, /^ev_[a-f0-9]{64}$/);
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
      await page.close();
    }
  },
);

test(
  "N11c: browser annotation is evidence-logged and the annotated DOM is reachable",
  { skip: chromeAvailable() ? false : "Google Chrome is not available" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "reef-n11c-browser-"));
    const page = await startLocalPage(`<!doctype html>
<html>
  <head><title>Reef Browser Annotation Test</title></head>
  <body>
    <section id="annotated" style="position:absolute;left:400px;top:180px;width:420px;height:220px">
      <h1>Annotated Reef Element</h1>
      <p>Agent should read this exact DOM after annotation.</p>
    </section>
  </body>
</html>`);
    const server = new ReefServer({ persistDir: dir });
    const port = await server.listen(0);
    try {
      const created = await request(port, "POST", "/sessions", {
        task: "N11c governed browser annotation",
        persist: true,
        browser: {
          url: page.url,
          annotation: {
            url: page.url,
            note: "Annotate the Reef element for the agent",
            bbox: {
              x: 480,
              y: 220,
              width: 80,
              height: 60,
              viewportWidth: 1280,
              viewportHeight: 900,
            },
          },
        },
      });
      assert.equal(created.status, 201);
      const id = created.json.id as string;
      const frames = await collectSSE(port, `/sessions/${id}/events`);
      const annotationInput = frames.find(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          frame.event.summary.includes("browser annotation input"),
      );
      assert.ok(annotationInput, "annotation input should be evidence");
      if (annotationInput?.type === "event") {
        assert.match(annotationInput.event.evidenceId, /^ev_[a-f0-9]{64}$/);
        assert.equal(
          (
            annotationInput.event.data.annotation as
              { note?: string } | undefined
          )?.note,
          "Annotate the Reef element for the agent",
        );
      }

      const tools = frames
        .filter(
          (frame) =>
            frame.type === "event" &&
            frame.event.kind === "action.executed" &&
            frame.event.data.actionType === "tool",
        )
        .map((frame) =>
          frame.type === "event"
            ? (frame.event.data.payload as { tool?: string } | undefined)?.tool
            : undefined,
        );
      assert.deepEqual(tools, [
        "browser.navigate",
        "browser.annotate",
        "browser.getDom",
      ]);

      const resolved = frames.find(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          frame.event.summary.includes("browser annotation resolved"),
      );
      assert.ok(resolved, "annotation should resolve to a selector");
      if (resolved?.type === "event") {
        const annotation = resolved.event.data.annotation as
          { selector?: string; xpath?: string; text?: string } | undefined;
        assert.equal(annotation?.selector, "#annotated");
        assert.match(annotation?.xpath ?? "", /annotated/);
        assert.match(annotation?.text ?? "", /Agent should read/);
      }

      const domRead = frames.find(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "action.executed" &&
          frame.event.summary.includes("browser.getDom"),
      );
      assert.ok(domRead, "annotated element DOM should be read");
      if (domRead?.type === "event") {
        const output = (
          domRead.event.data.result as { output?: { sha256?: string } }
        ).output;
        assert.match(output?.sha256 ?? "", /^[a-f0-9]{64}$/);
      }

      const before = await request(port, "GET", `/sessions/${id}/verify`);
      assert.equal(before.status, 200);
      assert.equal(before.json.ok, true);

      const logPath = join(dir, id, "session.log.jsonl");
      const raw = readFileSync(logPath);
      const offset = raw.indexOf(Buffer.from("Annotate the Reef element"));
      assert.ok(
        offset >= 0,
        "annotation evidence should contain a flippable note byte",
      );
      raw[offset] = raw[offset] === 0x41 ? 0x42 : 0x41;
      writeFileSync(logPath, raw);

      const after = await request(port, "GET", `/sessions/${id}/verify`);
      assert.equal(after.status, 200);
      assert.equal(after.json.ok, false);
      assert.match(after.json.log, /broken/i);
    } finally {
      await server.close();
      await page.close();
    }
  },
);

test("C0: edition split reports flavor and community rejects gateway provider", async () => {
  const community = new ReefServer({ edition: "community" });
  const communityPort = await community.listen(0);
  try {
    const edition = await request(communityPort, "GET", "/edition");
    assert.equal(edition.status, 200);
    assert.equal(edition.json.edition, "community");
    assert.equal(edition.json.providers.gateway.available, false);
    assert.equal(edition.json.commercialSurfaces.available, false);

    const created = await request(communityPort, "POST", "/sessions", {
      task: "C0 community gateway must not route",
      model: { provider: "gateway" },
    });
    assert.equal(created.status, 201);
    const frames = await collectSSE(
      communityPort,
      `/sessions/${created.json.id}/events`,
    );
    const sealed = frames.at(-1);
    assert.equal(sealed?.type, "sealed");
    if (sealed?.type === "sealed") {
      assert.equal(sealed.snapshot.outcome, "failed");
      assert.equal(sealed.verify.ok, true);
    }
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "session.sealed" &&
          String(frame.event.data.reason).includes(
            "gateway provider is not available",
          ),
      ),
      "community gateway request should be denied as session evidence",
    );
    assert.equal(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "action.executed" &&
          frame.event.summary.includes("gateway"),
      ),
      false,
      "community must not execute any gateway route",
    );
  } finally {
    await community.close();
  }

  const commercial = new ReefServer({ edition: "commercial" });
  const commercialPort = await commercial.listen(0);
  try {
    const edition = await request(commercialPort, "GET", "/edition");
    assert.equal(edition.status, 200);
    assert.equal(edition.json.edition, "commercial");
    assert.equal(edition.json.providers.gateway.available, true);
    assert.equal(edition.json.providers.gateway.gated, true);
    assert.equal(edition.json.commercialSurfaces.available, true);
    assert.equal(edition.json.commercialSurfaces.gated, true);
  } finally {
    await commercial.close();
  }
});

test("C1: commercial gateway records entitlement, quota, route evidence and denies no-license", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-c1-gateway-"));
  const gateway = await startStubGateway();
  const server = new ReefServer({ persistDir: dir, edition: "commercial" });
  const port = await server.listen(0);
  try {
    const created = await request(port, "POST", "/sessions", {
      task: "C1 commercial session routes through gateway stub",
      persist: true,
      model: {
        provider: "gateway",
        gatewayUrl: gateway.url,
        licenseToken: TEST_GATEWAY_LICENSE_TOKEN,
        name: "reef-gateway-stub",
      },
    });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    const frames = await collectSSE(port, `/sessions/${id}/events`);
    const sealed = frames.at(-1);
    assert.equal(sealed?.type, "sealed");
    if (sealed?.type === "sealed") {
      assert.equal(sealed.snapshot.outcome, "completed");
      assert.equal(sealed.verify.ok, true);
    }

    const entitlement = frames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "observation" &&
        (
          frame.event.data.entitlementDecision as
            { allowed?: boolean } | undefined
        )?.allowed === true,
    );
    assert.ok(entitlement, "entitlement decision should be evidence");
    if (entitlement?.type === "event") {
      assert.match(entitlement.event.evidenceId, /^ev_[a-f0-9]{64}$/);
      assert.match(
        (
          entitlement.event.data.entitlementDecision as {
            licenseSha256?: string;
          }
        ).licenseSha256 ?? "",
        /^[a-f0-9]{64}$/,
      );
    }

    const quota = frames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "observation" &&
        (frame.event.data.quotaDecision as { allowed?: boolean } | undefined)
          ?.allowed === true,
    );
    assert.ok(quota, "quota decision should be evidence");

    const route = frames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "observation" &&
        (frame.event.data.gatewayRoute as { route?: string } | undefined)
          ?.route === "/v1/completions",
    );
    assert.ok(route, "gateway route should be evidence");
    if (route?.type === "event") {
      assert.match(route.event.evidenceId, /^ev_[a-f0-9]{64}$/);
      assert.equal(
        (route.event.data.gatewayRoute as { gatewayUrl?: string }).gatewayUrl,
        gateway.url,
      );
    }

    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (frame.event.data.modelUsage as { totalTokens?: number } | undefined)
            ?.totalTokens === 36,
      ),
      "gateway provider usage should be normalized into evidence",
    );

    const before = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);

    const logPath = join(dir, id, "session.log.jsonl");
    const raw = readFileSync(logPath);
    const offset = raw.indexOf(Buffer.from("gateway route selected"));
    assert.ok(
      offset >= 0,
      "gateway route evidence should contain flippable text",
    );
    raw[offset] = raw[offset] === 0x67 ? 0x68 : 0x67;
    writeFileSync(logPath, raw);

    const after = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(after.status, 200);
    assert.equal(after.json.ok, false);
    assert.match(after.json.log, /broken/i);

    const noLicense = await request(port, "POST", "/sessions", {
      task: "C1 commercial gateway denied without license",
      persist: true,
      model: {
        provider: "gateway",
        gatewayUrl: gateway.url,
      },
    });
    assert.equal(noLicense.status, 201);
    const deniedFrames = await collectSSE(
      port,
      `/sessions/${noLicense.json.id}/events`,
    );
    assert.ok(
      deniedFrames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (
            frame.event.data.entitlementDecision as
              { allowed?: boolean } | undefined
          )?.allowed === false,
      ),
      "no-license denial should record entitlement evidence",
    );
    assert.ok(
      deniedFrames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (frame.event.data.quotaDecision as { allowed?: boolean } | undefined)
            ?.allowed === false,
      ),
      "no-license denial should record quota evidence",
    );
    assert.equal(
      deniedFrames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          frame.event.data.gatewayRoute !== undefined,
      ),
      false,
      "denied no-license session must not record a gateway route",
    );
  } finally {
    await server.close();
    await gateway.close();
  }

  const community = new ReefServer({ edition: "community" });
  const communityPort = await community.listen(0);
  try {
    const created = await request(communityPort, "POST", "/sessions", {
      task: "C1 community cannot reach gateway path",
      model: {
        provider: "gateway",
        gatewayUrl: "http://127.0.0.1:1",
        licenseToken: TEST_GATEWAY_LICENSE_TOKEN,
      },
    });
    assert.equal(created.status, 201);
    const frames = await collectSSE(
      communityPort,
      `/sessions/${created.json.id}/events`,
    );
    const sealed = frames.at(-1);
    assert.equal(sealed?.type, "sealed");
    if (sealed?.type === "sealed") {
      assert.equal(sealed.snapshot.outcome, "failed");
    }
    assert.equal(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          frame.event.data.gatewayRoute !== undefined,
      ),
      false,
      "community build cannot record or reach a gateway route",
    );
  } finally {
    await community.close();
  }
});

test("N8: chat turns record conversation approval evidence and tamper per turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-n8-chat-"));
  const server = new ReefServer({ persistDir: dir });
  const port = await server.listen(0);
  try {
    const first = await request(port, "POST", "/sessions", {
      task: "N8 first conversational turn",
      persist: true,
      conversation: {
        id: "conv-n8",
        turn: 1,
        autopilot: false,
        approvalMode: "ask",
      },
    });
    assert.equal(first.status, 201);
    const firstId = first.json.id as string;
    const firstFrames = await collectSSE(port, `/sessions/${firstId}/events`);
    const askEvidence = firstFrames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "observation" &&
        (
          frame.event.data.conversation as
            | { id?: string; approvalMode?: string; autopilot?: boolean }
            | undefined
        )?.id === "conv-n8",
    );
    assert.ok(askEvidence, "ask-mode approval should be recorded as evidence");
    if (askEvidence?.type === "event") {
      assert.match(askEvidence.event.evidenceId, /^ev_[a-f0-9]{64}$/);
      const conversation = askEvidence.event.data.conversation as {
        turn?: number;
        autopilot?: boolean;
        approvalMode?: string;
        approvalDecision?: { source?: string; approved?: boolean };
      };
      assert.equal(conversation.turn, 1);
      assert.equal(conversation.autopilot, false);
      assert.equal(conversation.approvalMode, "ask");
      assert.equal(conversation.approvalDecision?.source, "human");
      assert.equal(conversation.approvalDecision?.approved, true);
    }

    const second = await request(port, "POST", "/sessions", {
      task: "N8 second conversational turn",
      persist: true,
      conversation: {
        id: "conv-n8",
        turn: 2,
        parentSessionId: firstId,
        autopilot: true,
        approvalMode: "auto",
      },
    });
    assert.equal(second.status, 201);
    const secondId = second.json.id as string;
    const secondFrames = await collectSSE(port, `/sessions/${secondId}/events`);
    const autoEvidence = secondFrames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "observation" &&
        (
          frame.event.data.conversation as
            { parentSessionId?: string; approvalMode?: string } | undefined
        )?.parentSessionId === firstId,
    );
    assert.ok(
      autoEvidence,
      "autopilot approval should be recorded as evidence",
    );
    if (autoEvidence?.type === "event") {
      const conversation = autoEvidence.event.data.conversation as {
        turn?: number;
        autopilot?: boolean;
        approvalMode?: string;
        approvalDecision?: { source?: string };
      };
      assert.equal(conversation.turn, 2);
      assert.equal(conversation.autopilot, true);
      assert.equal(conversation.approvalMode, "auto");
      assert.equal(conversation.approvalDecision?.source, "autopilot");
    }

    const firstBefore = await request(
      port,
      "GET",
      `/sessions/${firstId}/verify`,
    );
    const secondBefore = await request(
      port,
      "GET",
      `/sessions/${secondId}/verify`,
    );
    assert.equal(firstBefore.status, 200);
    assert.equal(secondBefore.status, 200);
    assert.equal(firstBefore.json.ok, true);
    assert.equal(secondBefore.json.ok, true);

    const logPath = join(dir, firstId, "session.log.jsonl");
    const raw = readFileSync(logPath);
    const offset = raw.indexOf(Buffer.from("human"));
    assert.ok(
      offset >= 0,
      "chat approval evidence should contain flippable text",
    );
    raw[offset] = raw[offset] === 0x68 ? 0x69 : 0x68;
    writeFileSync(logPath, raw);

    const firstAfter = await request(
      port,
      "GET",
      `/sessions/${firstId}/verify`,
    );
    const secondAfter = await request(
      port,
      "GET",
      `/sessions/${secondId}/verify`,
    );
    assert.equal(firstAfter.status, 200);
    assert.equal(firstAfter.json.ok, false);
    assert.match(firstAfter.json.log, /broken/i);
    assert.equal(secondAfter.status, 200);
    assert.equal(secondAfter.json.ok, true);
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
      usage.json.remaining.map(
        (entry: { provider: string; status: string }) => [
          entry.provider,
          entry.status,
        ],
      ),
      [
        ["anthropic", "pending-key"],
        ["bedrock", "not-available"],
      ],
    );
  } finally {
    await readingServer.close();
  }
});

test("C3: Account panel state distinguishes community BYOK and commercial stub account evidence", async () => {
  const community = new ReefServer({ edition: "community" });
  const communityPort = await community.listen(0);
  try {
    const state = await request(
      communityPort,
      "GET",
      "/account?provider=bedrock&model=Claude%20Sonnet%204.5&source=BYOK",
    );
    assert.equal(state.status, 200);
    assert.equal(state.json.edition, "community");
    assert.equal(state.json.identity.kind, "local-byok");
    assert.equal(state.json.account.signedIn, false);
    assert.equal(state.json.plan.upgradeAvailable, false);
    assert.equal(state.json.plan.quota.status, "not-available");
  } finally {
    await community.close();
  }

  const dir = mkdtempSync(join(tmpdir(), "reef-c3-account-"));
  const gateway = await startStubGateway();
  const commercial = new ReefServer({ persistDir: dir, edition: "commercial" });
  const port = await commercial.listen(0);
  const query = `/account?provider=gateway&model=reef-gateway-stub&gatewayUrl=${encodeURIComponent(gateway.url)}`;
  try {
    const beforeLogin = await request(port, "GET", query);
    assert.equal(beforeLogin.status, 200);
    assert.equal(beforeLogin.json.edition, "commercial");
    assert.equal(beforeLogin.json.account.signedIn, false);
    assert.equal(beforeLogin.json.entitlement.allowed, false);
    assert.equal(beforeLogin.json.plan.quota.status, "missing-account");

    const login = await request(port, "POST", `${query.replace("/account", "/account/login")}`, {
      userId: "octopus-c3-user",
      displayName: "Octopus C3 User",
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.account.signedIn, true);
    assert.equal(login.json.account.userId, "octopus-c3-user");
    assert.equal(login.json.entitlement.allowed, true);
    assert.match(login.json.account.licenseSha256, /^[a-f0-9]{64}$/);

    const created = await request(port, "POST", "/sessions", {
      task: "C3 account evidence snapshot",
      persist: true,
      account: {
        provider: "gateway",
        model: "reef-gateway-stub",
        gatewayUrl: gateway.url,
      },
    });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    const frames = await collectSSE(port, `/sessions/${id}/events`);
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (frame.event.data.accountIdentity as { provider?: string } | undefined)
            ?.provider === "gateway",
      ),
      "account identity should be an evidence link",
    );
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (
            frame.event.data.accountEntitlement as
              { allowed?: boolean } | undefined
          )?.allowed === true,
      ),
      "account entitlement should be an evidence link",
    );
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (frame.event.data.accountUsage as { totals?: unknown } | undefined)
            ?.totals !== undefined,
      ),
      "account usage should be an evidence link",
    );

    const before = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);

    const logPath = join(dir, id, "session.log.jsonl");
    const raw = readFileSync(logPath);
    const offset = raw.indexOf(Buffer.from("account entitlement"));
    assert.ok(offset >= 0, "account evidence should contain flippable text");
    raw[offset] = raw[offset] === 0x61 ? 0x62 : 0x61;
    writeFileSync(logPath, raw);

    const after = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(after.status, 200);
    assert.equal(after.json.ok, false);
    assert.match(after.json.log, /broken/i);

    const logout = await request(port, "POST", query.replace("/account", "/account/logout"));
    assert.equal(logout.status, 200);
    assert.equal(logout.json.account.signedIn, false);
    assert.equal(logout.json.entitlement.allowed, false);
  } finally {
    await commercial.close();
    await gateway.close();
  }
});

test("C2: Account plan quota and usage come from aggregation and stub gateway ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-c2-plan-"));
  const gateway = await startStubGateway({
    quotaLimitTokens: 1000,
    initialUsedTokens: 41,
  });
  const provider: ModelProvider = {
    name: "scripted-c2-usage",
    complete: () =>
      Promise.resolve({
        content: [
          {
            type: "tool_use",
            id: "c2",
            name: "done",
            input: { summary: "C2 usage recorded" },
          },
        ],
        stopReason: "tool_use",
        usage: {
          provider: "anthropic",
          model: "claude-test",
          inputTokens: 123,
          outputTokens: 456,
          totalTokens: 579,
        },
      }),
  };
  const server = new ReefServer({
    persistDir: dir,
    edition: "commercial",
    driverFactory: () => ({
      driver: new AgentWorker({ provider, maxTurns: 2 }),
      authorizer: reefAllowlist(),
      executor: new WorkspaceExecutor(dir),
    }),
  });
  const port = await server.listen(0);
  const accountPath = `/account?provider=gateway&model=reef-gateway-stub&gatewayUrl=${encodeURIComponent(gateway.url)}`;
  try {
    const usageRun = await request(port, "POST", "/sessions", {
      task: "C2 injected usage",
      persist: true,
    });
    assert.equal(usageRun.status, 201);
    await collectSSE(port, `/sessions/${usageRun.json.id}/events`);

    const login = await request(port, "POST", accountPath.replace("/account", "/account/login"));
    assert.equal(login.status, 200);

    const panel = await request(port, "GET", accountPath);
    assert.equal(panel.status, 200);
    assert.equal(panel.json.usage.totals.calls, 1);
    assert.equal(panel.json.usage.totals.inputTokens, 123);
    assert.equal(panel.json.usage.totals.outputTokens, 456);
    assert.equal(panel.json.usage.totals.totalTokens, 579);
    assert.equal(panel.json.usage.totals.costUsd, 0.001491);
    assert.equal(panel.json.plan.quota.status, "available");
    assert.equal(panel.json.plan.quota.usedTokens, 41);
    assert.equal(panel.json.plan.quota.remainingTokens, 959);
    assert.equal(panel.json.plan.quota.limitTokens, 1000);
    assert.match(panel.json.plan.quota.source, /stub-gateway/);

    const created = await request(port, "POST", "/sessions", {
      task: "C2 account quota evidence snapshot",
      persist: true,
      account: {
        provider: "gateway",
        model: "reef-gateway-stub",
        gatewayUrl: gateway.url,
      },
    });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    const frames = await collectSSE(port, `/sessions/${id}/events`);
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (
            frame.event.data.accountUsage as
              { totals?: { totalTokens?: number; costUsd?: number } } | undefined
          )?.totals?.totalTokens === 579,
      ),
      "usage totals should be sourced from N6 aggregation",
    );
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.event.kind === "observation" &&
          (
            frame.event.data.planQuota as
              { usedTokens?: number; remainingTokens?: number } | undefined
          )?.usedTokens === 41 &&
          (
            frame.event.data.planQuota as
              { usedTokens?: number; remainingTokens?: number } | undefined
          )?.remainingTokens === 959,
      ),
      "plan quota should be sourced from the stub gateway ledger",
    );

    const before = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);

    const logPath = join(dir, id, "session.log.jsonl");
    const raw = readFileSync(logPath);
    const offset = raw.indexOf(Buffer.from("plan quota"));
    assert.ok(offset >= 0, "quota evidence should contain flippable text");
    raw[offset] = raw[offset] === 0x70 ? 0x71 : 0x70;
    writeFileSync(logPath, raw);

    const after = await request(port, "GET", `/sessions/${id}/verify`);
    assert.equal(after.status, 200);
    assert.equal(after.json.ok, false);
    assert.match(after.json.log, /broken/i);
  } finally {
    await server.close();
    await gateway.close();
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
          (frame.event.data.steeringSet as { active?: unknown } | undefined)
            ?.active,
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
          frame.event.summary ===
            "N3 custom steering changed the mock session.",
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
    assert.ok(
      action,
      "spec transition should run through a governed tool action",
    );
    const observed = frames.find(
      (frame) =>
        frame.type === "event" &&
        frame.event.kind === "observation" &&
        typeof frame.event.data.transitionEvidenceId === "string",
    );
    assert.ok(
      observed,
      "session should observe the spec transition evidence id",
    );

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
    assert.ok(
      offset >= 0,
      "workstate trail should contain a flippable transition byte",
    );
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
