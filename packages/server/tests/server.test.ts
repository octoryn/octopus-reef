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
