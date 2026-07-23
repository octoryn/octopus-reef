import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVerificationSandboxRunnerServer } from "../src/sandbox-runner.js";

test("remote sandbox bridge authenticates and confines files, commands, and environment", async (t) => {
  const token = "verification-runner-test-token-at-least-32-bytes";
  const workspace = mkdtempSync(join(tmpdir(), "reef-runner-test-"));
  const server = createVerificationSandboxRunnerServer({
    authToken: token,
    workspacePath: workspace,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  assert.equal(
    (
      await request(baseUrl, token, "/v1/files/write", {
        path: "input.txt",
        contentBase64: Buffer.from("immutable input\n").toString("base64"),
      })
    ).status,
    200,
  );
  const execution = await request(baseUrl, token, "/v1/execute", {
    argv: [
      "node",
      "-e",
      "const fs=require('node:fs');fs.writeFileSync('output.txt',fs.readFileSync('input.txt','utf8').trim()+':'+process.env.SAFE)",
    ],
    workingDirectory: ".",
    timeoutMs: 5000,
    outputLimitBytes: 64 * 1024,
    environment: { SAFE: "profile-owned" },
  });
  assert.equal(execution.status, 200);
  assert.equal((execution.body as { exitCode: number }).exitCode, 0);
  const output = await request(baseUrl, token, "/v1/files/read", {
    path: "output.txt",
    maxBytes: 1024,
  });
  assert.equal(output.status, 200);
  assert.equal(
    Buffer.from(
      (output.body as { contentBase64: string }).contentBase64,
      "base64",
    ).toString("utf8"),
    "immutable input:profile-owned",
  );

  assert.equal(
    (
      await request(
        baseUrl,
        "wrong-token-that-is-still-at-least-32-bytes",
        "/v1/files/read",
        {
          path: "output.txt",
          maxBytes: 1024,
        },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(baseUrl, token, "/v1/files/write", {
        path: "../escape",
        contentBase64: Buffer.from("no").toString("base64"),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(baseUrl, token, "/v1/execute", {
        argv: ["node", "-e", "process.exit(0)"],
        workingDirectory: ".",
        timeoutMs: 5000,
        outputLimitBytes: 1024,
        environment: { AWS_SECRET_ACCESS_KEY: "forbidden" },
      })
    ).status,
    400,
  );
});

async function request(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
