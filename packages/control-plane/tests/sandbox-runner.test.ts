import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxRunnerServer } from "../src/sandbox-runner.js";

const TOKEN = "runner-test-token-that-is-at-least-32-bytes";

test("sandbox runner authenticates, confines cwd and scrubs AWS/task env", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "reef-runner-"));
  const server = createSandboxRunnerServer({ authToken: TOKEN, workspacePath });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1/execute`;

    const denied = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: { argv: ["node", "--version"] } }),
    });
    assert.equal(denied.status, 401);

    const executed = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        command: {
          argv: [
            "node",
            "-e",
            "process.stdout.write(JSON.stringify({safe:process.env.SAFE,aws:process.env.AWS_SECRET_ACCESS_KEY,reef:process.env.REEF_PRIVATE,imds:process.env.AWS_EC2_METADATA_DISABLED,cwd:process.cwd()}))",
          ],
          env: {
            SAFE: "visible",
            AWS_SECRET_ACCESS_KEY: "must-not-leak",
            REEF_PRIVATE: "must-not-leak",
          },
        },
      }),
    });
    assert.equal(executed.status, 200);
    const result = (await executed.json()) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      safe: "visible",
      imds: "true",
      cwd: realpathSync(workspacePath),
    });

    const escaped = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        command: { argv: ["node", "--version"], cwd: "../peer" },
      }),
    });
    assert.equal(escaped.status, 400);
    assert.match(JSON.stringify(await escaped.json()), /escapes/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("sandbox runner finalises a git-backed candidate over /v1/finalize", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "reef-runner-finalize-"));
  const git = async (argv: readonly string[]): Promise<void> => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("git", [...argv], {
      cwd: workspacePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@octopus.invalid",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@octopus.invalid",
      },
    });
    assert.equal(result.status, 0, String(result.stderr));
  };
  const { writeFileSync } = await import("node:fs");
  await git(["init", "--quiet"]);
  writeFileSync(join(workspacePath, "a.txt"), "one\n");
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "baseline"]);
  writeFileSync(join(workspacePath, "a.txt"), "two\n");

  const server = createSandboxRunnerServer({ authToken: TOKEN, workspacePath });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1/finalize`;

    const denied = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ finalize: { candidateBranch: "x", commitMessage: "y" } }),
    });
    assert.equal(denied.status, 401);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        finalize: {
          candidateBranch: "reef-candidate/run-http-0",
          commitMessage: "reef: http candidate",
          testCommand: { argv: ["node", "-e", "console.log('ok')"] },
          push: false,
        },
      }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      commit: string;
      changed: boolean;
      diff: string;
      pushed: boolean;
      test: { passed: boolean; report: string };
    };
    assert.equal(result.changed, true);
    assert.equal(result.pushed, false);
    assert.equal(result.commit.length, 40);
    assert.match(result.diff, /\+two/);
    assert.equal(result.test.passed, true);
    assert.match(result.test.report, /ok/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
