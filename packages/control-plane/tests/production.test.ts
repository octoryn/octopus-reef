import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SandboxActionExecutor,
  type SandboxExecution,
  type SandboxHandle,
} from "../src/index.js";
import { AwsSecretsManagerSecretResolver } from "../src/adapters/aws.js";
import { postgresConnectionFromEnvironment } from "../src/production.js";

test("RDS verify-full loads a CA bundle and rejects ambiguous TLS config", () => {
  const directory = mkdtempSync(join(tmpdir(), "reef-rds-ca-"));
  const caFile = join(directory, "rds-ca.pem");
  writeFileSync(
    caFile,
    "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
  );
  try {
    const connection = postgresConnectionFromEnvironment({
      REEF_CONTROL_PLANE_DATABASE_URL: "postgres://reef@rds.example/reef",
      REEF_CONTROL_PLANE_DATABASE_SSL_MODE: "verify-full",
      REEF_CONTROL_PLANE_DATABASE_CA_FILE: caFile,
    });
    assert.deepEqual(connection.ssl, {
      ca: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
      rejectUnauthorized: true,
    });
    assert.throws(
      () =>
        postgresConnectionFromEnvironment({
          REEF_CONTROL_PLANE_DATABASE_URL: "postgres://reef@rds.example/reef",
          REEF_CONTROL_PLANE_DATABASE_SSL_MODE: "verify-full",
        }),
      /requires the RDS\/PostgreSQL CA bundle/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Secrets Manager resolver supports string and JSON-field secret refs", async () => {
  const requested: string[] = [];
  const resolver = new AwsSecretsManagerSecretResolver({
    client: {
      send(command: { readonly input: { readonly SecretId?: string } }) {
        requested.push(command.input.SecretId ?? "");
        return Promise.resolve({
          SecretString: JSON.stringify({ apiKey: "resolved-key" }),
        });
      },
    } as never,
  });
  const values = await resolver.resolve(
    { organisationId: "org", projectId: "project" },
    [
      {
        name: "modelApiKey",
        secretRef: "aws-secretsmanager://reef%2Fmodel#apiKey",
      },
      {
        name: "raw",
        secretRef: "aws-secretsmanager://reef%2Fmodel",
      },
    ],
  );
  assert.equal(values["modelApiKey"], "resolved-key");
  assert.equal(values["raw"], JSON.stringify({ apiKey: "resolved-key" }));
  assert.deepEqual(requested, ["reef/model"]);
});

test("sandbox action executor wires read, edit and command into the sandbox", async () => {
  const executions: SandboxExecution[] = [];
  const sandbox: SandboxHandle = {
    id: "sandbox",
    workspacePath: "/workspace",
    execute(command) {
      executions.push(command);
      return Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
    },
  };
  const executor = new SandboxActionExecutor(sandbox);
  assert.equal(
    (await executor.execute({ type: "read", summary: "read", target: "a.txt" }))
      .ok,
    true,
  );
  assert.equal(
    (
      await executor.execute({
        type: "edit",
        summary: "edit",
        target: "dir/a.txt",
        payload: { content: "hello" },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await executor.execute({
        type: "command",
        summary: "test",
        payload: { command: "npm test" },
      })
    ).ok,
    true,
  );
  assert.equal(executions.length, 3);
  assert.equal(
    (
      await executor.execute({
        type: "read",
        summary: "escape",
        target: "../x",
      })
    ).ok,
    false,
  );
});
