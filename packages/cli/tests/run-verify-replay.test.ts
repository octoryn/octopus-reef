import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const CLI = resolve("packages/cli/src/cli.ts");

function reef(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, ...args],
    {
      cwd: resolve("."),
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function jsonOf<T>(result: {
  readonly stdout: string;
  readonly stderr: string;
}): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (err) {
    throw new Error(
      `could not parse CLI JSON: ${err instanceof Error ? err.message : String(err)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function flipOneByte(path: string, needle: string): void {
  const raw = readFileSync(path);
  const offset = raw.indexOf(Buffer.from(needle));
  assert.ok(offset >= 0, `${path} should contain ${needle}`);
  raw[offset] = raw[offset] === 0x61 ? 0x62 : 0x61;
  writeFileSync(path, raw);
}

test("reef CLI run, verify, replay, then tamper-red", () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-c-cli-"));

  const run = reef(["run", "C CLI governed session", "--out", dir, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const runJson = jsonOf<{
    verify: { ok: boolean };
    snapshot: { logHead: string };
  }>(run);
  assert.equal(runJson.verify.ok, true);
  assert.match(runJson.snapshot.logHead, /^[0-9a-f]{64}$/);

  const verify = reef(["verify", dir, "--json"]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(jsonOf<{ ok: boolean }>(verify).ok, true);

  const replay = reef(["replay", dir, "--json"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.ok(jsonOf<{ events: readonly unknown[] }>(replay).events.length > 0);

  flipOneByte(join(dir, "session.log.jsonl"), "governed");

  const verifyRed = reef(["verify", dir, "--json"]);
  assert.equal(verifyRed.status, 1);
  assert.equal(jsonOf<{ ok: boolean }>(verifyRed).ok, false);

  const replayRed = reef(["replay", dir, "--json"]);
  assert.equal(replayRed.status, 1);
  assert.equal(jsonOf<{ ok: boolean }>(replayRed).ok, false);
});
