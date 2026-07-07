/**
 * M2: the server daemon. Real HTTP requests against a server on an ephemeral
 * port prove the acceptance — two independent clients observe one live session
 * and both verify it store-untrusting over the wire.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { ReefServer } from "../src/index.js";
import type { ServerEvent } from "@octopus-reef/protocol";

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
