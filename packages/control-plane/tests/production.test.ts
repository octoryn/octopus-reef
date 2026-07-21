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
import {
  AwsEcsFargateSandboxProvisioner,
  AwsEcsTaskHttpCommandExecutor,
  AwsSecretsManagerSecretResolver,
} from "../src/adapters/aws.js";
import {
  AWS_RDS_GLOBAL_CA_BUNDLE_PATH,
  createProductionSandbox,
  postgresConnectionFromEnvironment,
} from "../src/production.js";

test("RDS verify-full loads a CA bundle and rejects ambiguous TLS config", () => {
  assert.equal(
    AWS_RDS_GLOBAL_CA_BUNDLE_PATH,
    "/etc/ssl/certs/aws-rds-global-bundle.pem",
  );
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

test("ECS task runner resolves the private task address and authenticates", async () => {
  const requests: Array<{
    url: string;
    authorization?: string;
    body?: unknown;
  }> = [];
  const client = {
    send() {
      return Promise.resolve({
        tasks: [
          {
            lastStatus: "RUNNING",
            attachments: [
              {
                details: [{ name: "privateIPv4Address", value: "10.0.3.42" }],
              },
            ],
          },
        ],
      });
    },
  };
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const authorization = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;
    requests.push({
      url,
      ...(authorization !== undefined ? { authorization } : {}),
      ...(init?.body !== undefined
        ? { body: JSON.parse(String(init.body)) as unknown }
        : {}),
    });
    return url.endsWith("/readyz")
      ? new Response(JSON.stringify({ ready: true }), { status: 200 })
      : new Response(
          JSON.stringify({ exitCode: 0, stdout: "ok", stderr: "" }),
          { status: 200 },
        );
  }) as typeof fetch;
  const executor = new AwsEcsTaskHttpCommandExecutor({
    cluster: "cluster",
    client: client as never,
    fetchImpl,
  });
  await executor.ready("task-arn", { authToken: "derived-token" });
  const result = await executor.execute(
    "task-arn",
    { argv: ["node", "--version"] },
    { authToken: "derived-token" },
  );
  assert.equal(result.stdout, "ok");
  assert.equal(requests[0]?.url, "http://10.0.3.42:8081/readyz");
  assert.deepEqual(requests[1], {
    url: "http://10.0.3.42:8081/v1/execute",
    authorization: "Bearer derived-token",
    body: { command: { argv: ["node", "--version"] } },
  });
});

test("ECS production wiring requires a runner HMAC secret without a legacy bridge", () => {
  assert.throws(
    () =>
      createProductionSandbox({
        REEF_SANDBOX_ADAPTER: "ecs",
        REEF_ECS_CLUSTER: "cluster",
        REEF_ECS_TASK_DEFINITION: "sandbox:1",
        REEF_ECS_SUBNETS: "subnet-private",
        REEF_ECS_SECURITY_GROUPS: "sg-sandbox",
      }),
    /REEF_ECS_RUNNER_SHARED_SECRET/,
  );
});

test("ECS provisioner injects a derived runner token and leaves ECS Exec off", async () => {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    send(command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) {
      commands.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "RunTaskCommand") {
        return Promise.resolve({ tasks: [{ taskArn: "task-arn" }] });
      }
      if (command.constructor.name === "DescribeTasksCommand") {
        return Promise.resolve({
          tasks: [{ taskArn: "task-arn", lastStatus: "RUNNING" }],
        });
      }
      return Promise.resolve({});
    },
  };
  const contexts: unknown[] = [];
  const commandExecutor = {
    ready(_taskArn: string, context: unknown) {
      contexts.push(context);
      return Promise.resolve();
    },
    execute(_taskArn: string, _command: unknown, context: unknown) {
      contexts.push(context);
      return Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
    },
  };
  const provisioner = new AwsEcsFargateSandboxProvisioner({
    cluster: "cluster",
    taskDefinition: "sandbox:1",
    subnets: ["subnet-private"],
    securityGroups: ["sg-sandbox"],
    commandExecutor,
    client: client as never,
    runnerSharedSecret: "a-worker-only-secret-with-at-least-32-bytes",
  });
  const handle = await provisioner.provision({
    organisationId: "org",
    projectId: "project",
    runId: "run",
    projectRef: "opaque-project",
    baselineRevisionRef: "opaque-baseline",
    attempt: 2,
  });
  assert.equal(
    (commands[0]?.input as { enableExecuteCommand?: boolean })
      .enableExecuteCommand,
    false,
  );
  const environment = (
    commands[0]?.input as {
      overrides?: {
        containerOverrides?: Array<{
          environment?: Array<{ name?: string; value?: string }>;
        }>;
      };
    }
  ).overrides?.containerOverrides?.[0]?.environment;
  const token = environment?.find(
    (entry) => entry.name === "REEF_SANDBOX_AUTH_TOKEN",
  )?.value;
  assert.ok(token);
  assert.notEqual(token, "a-worker-only-secret-with-at-least-32-bytes");
  await handle.execute({ argv: ["node", "--version"] });
  assert.deepEqual(contexts, [{ authToken: token }, { authToken: token }]);
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
