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
