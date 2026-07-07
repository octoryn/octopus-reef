/**
 * The extension host's SSE frame parser is pure — testable without VS Code or a
 * network. (The VS Code surface itself is verified by opening the extension.)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { drainSSE } from "../src/client.js";
import type { ServerEvent } from "@octopus-reef/protocol";

test("ide: drainSSE parses complete frames and keeps the partial tail", () => {
  const frames: ServerEvent[] = [];
  // two whole frames + a partial third arrive across chunk boundaries
  let rest = drainSSE(
    'data: {"type":"hello","id":"s","task":"t"}\n\n' +
      'data: {"type":"event","event":{"seq":1,"kind":"observation","summary":"x"}}\n\ndata: {"type":"sea',
    (f) => frames.push(f),
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.type, "hello");
  assert.equal(frames[1]?.type, "event");
  assert.equal(rest, 'data: {"type":"sea'); // partial retained

  // the rest of the third frame completes it
  rest = drainSSE(
    rest + 'led","snapshot":{"outcome":"completed"},"verify":{"ok":true}}\n\n',
    (f) => frames.push(f),
  );
  assert.equal(frames.length, 3);
  assert.equal(frames[2]?.type, "sealed");
  assert.equal(rest, "");
});

test("ide: drainSSE ignores malformed frames and unknown types", () => {
  const frames: ServerEvent[] = [];
  const rest = drainSSE(
    "data: not-json\n\n" +
      'data: {"type":"nope"}\n\n' +
      'data: {"type":"hello","id":"s","task":"t"}\n\n',
    (f) => frames.push(f),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.type, "hello");
  assert.equal(rest, "");
});
