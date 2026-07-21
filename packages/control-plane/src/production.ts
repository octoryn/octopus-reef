import { existsSync, readFileSync } from "node:fs";
import {
  AnthropicProvider,
  BedrockIamProvider,
  BedrockProvider,
} from "@octopus-reef/agent";
import { ECSClient } from "@aws-sdk/client-ecs";
import type {
  ArtifactStore,
  GitWorkspace,
  RunQueue,
  SandboxProvisioner,
  SecretResolver,
} from "./ports.js";
import type { AgentRun } from "./types.js";
import { ReefAgentKernel } from "./reef-kernel.js";
import { SandboxActionExecutor } from "./sandbox-executor.js";
import {
  AwsEcsFargateSandboxProvisioner,
  AwsEcsTaskHttpCommandExecutor,
  AwsS3ArtifactStore,
  AwsSecretsManagerSecretResolver,
  AwsSqsRunQueue,
  HttpEcsSandboxCommandExecutor,
} from "./adapters/aws.js";
import {
  DockerSandboxProvisioner,
  EnvironmentSecretResolver,
  GitWorktreeWorkspace,
  LocalArtifactStore,
  LocalSandboxProvisioner,
} from "./adapters/local.js";
import type {
  PostgresConnectionOptions,
  PostgresControlPlaneStore,
} from "./adapters/postgres.js";

/** Checksum-pinned into every official API/Worker image. */
export const AWS_RDS_GLOBAL_CA_BUNDLE_PATH =
  "/etc/ssl/certs/aws-rds-global-bundle.pem";

export function postgresConnectionFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PostgresConnectionOptions {
  const connectionString = required(
    environment,
    "REEF_CONTROL_PLANE_DATABASE_URL",
  );
  const explicitCaFile = optional(
    environment,
    "REEF_CONTROL_PLANE_DATABASE_CA_FILE",
  );
  const caBase64 = optional(
    environment,
    "REEF_CONTROL_PLANE_DATABASE_CA_BASE64",
  );
  if (explicitCaFile !== undefined && caBase64 !== undefined) {
    throw new Error("configure only one PostgreSQL CA source");
  }
  const mode =
    optional(environment, "REEF_CONTROL_PLANE_DATABASE_SSL_MODE") ??
    (explicitCaFile === undefined && caBase64 === undefined
      ? "disable"
      : "verify-full");
  if (!new Set(["disable", "require", "verify-full"]).has(mode)) {
    throw new Error(
      "REEF_CONTROL_PLANE_DATABASE_SSL_MODE must be disable, require, or verify-full",
    );
  }
  const caFile =
    explicitCaFile ??
    (mode === "verify-full" && existsSync(AWS_RDS_GLOBAL_CA_BUNDLE_PATH)
      ? AWS_RDS_GLOBAL_CA_BUNDLE_PATH
      : undefined);
  const ca =
    caFile !== undefined
      ? readFileSync(caFile, "utf8")
      : caBase64 !== undefined
        ? Buffer.from(caBase64, "base64").toString("utf8")
        : undefined;
  if (mode === "verify-full" && ca === undefined) {
    throw new Error("verify-full requires the RDS/PostgreSQL CA bundle");
  }
  return {
    connectionString,
    ssl:
      mode === "disable"
        ? false
        : {
            ...(ca !== undefined ? { ca } : {}),
            rejectUnauthorized: mode === "verify-full",
          },
    max: integer(environment, "REEF_CONTROL_PLANE_DATABASE_POOL_SIZE", 10),
    connectionTimeoutMillis: integer(
      environment,
      "REEF_CONTROL_PLANE_DATABASE_CONNECT_TIMEOUT_MS",
      5_000,
    ),
  };
}

export function createProductionQueue(
  store: PostgresControlPlaneStore,
  environment: NodeJS.ProcessEnv = process.env,
): RunQueue {
  const adapter = optional(environment, "REEF_RUN_QUEUE_ADAPTER") ?? "postgres";
  if (adapter === "postgres") return store;
  if (adapter === "sqs") {
    return new AwsSqsRunQueue({
      queueUrl: required(environment, "REEF_SQS_QUEUE_URL"),
      waitTimeSeconds: integer(environment, "REEF_SQS_WAIT_SECONDS", 10),
    });
  }
  throw new Error(`unsupported REEF_RUN_QUEUE_ADAPTER: ${adapter}`);
}

export function createProductionSandbox(
  environment: NodeJS.ProcessEnv = process.env,
): SandboxProvisioner {
  const adapter = optional(environment, "REEF_SANDBOX_ADAPTER") ?? "local";
  const root =
    optional(environment, "REEF_WORKSPACE_ROOT") ?? "/var/lib/reef/workspaces";
  if (adapter === "local") return new LocalSandboxProvisioner(root);
  if (adapter === "docker") {
    return new DockerSandboxProvisioner({
      root,
      image: required(environment, "REEF_SANDBOX_IMAGE"),
      ...(optional(environment, "REEF_SANDBOX_MEMORY") !== undefined
        ? { memory: optional(environment, "REEF_SANDBOX_MEMORY")! }
        : {}),
      ...(optional(environment, "REEF_SANDBOX_CPUS") !== undefined
        ? { cpus: optional(environment, "REEF_SANDBOX_CPUS")! }
        : {}),
    });
  }
  if (adapter === "ecs") {
    const cluster = required(environment, "REEF_ECS_CLUSTER");
    const client = new ECSClient({});
    const legacyEndpoint = optional(environment, "REEF_ECS_COMMAND_ENDPOINT");
    const runnerSharedSecret = optional(
      environment,
      "REEF_ECS_RUNNER_SHARED_SECRET",
    );
    const commandExecutor =
      legacyEndpoint === undefined
        ? new AwsEcsTaskHttpCommandExecutor({
            cluster,
            client,
            port: integer(environment, "REEF_ECS_RUNNER_PORT", 8081),
            scheme:
              optional(environment, "REEF_ECS_RUNNER_SCHEME") === "https"
                ? "https"
                : "http",
          })
        : new HttpEcsSandboxCommandExecutor({
            endpoint: legacyEndpoint,
            ...(optional(environment, "REEF_ECS_COMMAND_BEARER_TOKEN") !==
            undefined
              ? {
                  bearerToken: optional(
                    environment,
                    "REEF_ECS_COMMAND_BEARER_TOKEN",
                  )!,
                }
              : {}),
          });
    if (legacyEndpoint === undefined && runnerSharedSecret === undefined) {
      throw new Error(
        "REEF_ECS_RUNNER_SHARED_SECRET is required for the per-task ECS sandbox runner",
      );
    }
    return new AwsEcsFargateSandboxProvisioner({
      cluster,
      taskDefinition: required(environment, "REEF_ECS_TASK_DEFINITION"),
      subnets: csv(required(environment, "REEF_ECS_SUBNETS")),
      securityGroups: csv(required(environment, "REEF_ECS_SECURITY_GROUPS")),
      containerName:
        optional(environment, "REEF_ECS_CONTAINER_NAME") ?? "agent",
      platformVersion:
        optional(environment, "REEF_ECS_PLATFORM_VERSION") ?? "LATEST",
      workspaceRoot: root,
      runnerWorkspacePath:
        optional(environment, "REEF_ECS_RUNNER_WORKSPACE") ?? "/workspace",
      ...(runnerSharedSecret !== undefined ? { runnerSharedSecret } : {}),
      enableExecuteCommand: legacyEndpoint !== undefined,
      commandExecutor,
      client,
    });
  }
  throw new Error(`unsupported REEF_SANDBOX_ADAPTER: ${adapter}`);
}

export function createProductionSecrets(
  environment: NodeJS.ProcessEnv = process.env,
): SecretResolver {
  const adapter = optional(environment, "REEF_SECRET_RESOLVER") ?? "env";
  if (adapter === "env") return new EnvironmentSecretResolver(environment);
  if (adapter === "aws-secrets-manager") {
    return new AwsSecretsManagerSecretResolver();
  }
  throw new Error(`unsupported REEF_SECRET_RESOLVER: ${adapter}`);
}

export function createProductionArtifacts(
  environment: NodeJS.ProcessEnv = process.env,
): ArtifactStore | undefined {
  const adapter = optional(environment, "REEF_ARTIFACT_STORE") ?? "none";
  if (adapter === "none") return undefined;
  if (adapter === "local") {
    return new LocalArtifactStore(
      optional(environment, "REEF_ARTIFACT_ROOT") ?? "/var/lib/reef/artifacts",
    );
  }
  if (adapter === "s3") {
    return new AwsS3ArtifactStore({
      bucket: required(environment, "REEF_S3_ARTIFACT_BUCKET"),
      ...(optional(environment, "REEF_S3_ARTIFACT_PREFIX") !== undefined
        ? { prefix: optional(environment, "REEF_S3_ARTIFACT_PREFIX")! }
        : {}),
      ...(optional(environment, "REEF_S3_KMS_KEY_ID") !== undefined
        ? { kmsKeyId: optional(environment, "REEF_S3_KMS_KEY_ID")! }
        : {}),
    });
  }
  throw new Error(`unsupported REEF_ARTIFACT_STORE: ${adapter}`);
}

export function createProductionGit(
  environment: NodeJS.ProcessEnv = process.env,
): GitWorkspace | undefined {
  if (!boolean(environment, "REEF_GIT_ENABLED", false)) return undefined;
  return new GitWorktreeWorkspace({
    authorName:
      optional(environment, "REEF_GIT_AUTHOR_NAME") ?? "Octopus Reef Agent",
    authorEmail:
      optional(environment, "REEF_GIT_AUTHOR_EMAIL") ?? "agent@octopus.invalid",
  });
}

export function createProductionKernel(
  environment: NodeJS.ProcessEnv = process.env,
): ReefAgentKernel {
  const configuredProvider =
    optional(environment, "REEF_MODEL_PROVIDER") ?? "anthropic";
  return new ReefAgentKernel({
    provider: ({ run, secrets }) => {
      const provider = configString(run, "modelProvider") ?? configuredProvider;
      const model = configString(run, "model");
      if (provider === "anthropic") {
        const secretName =
          optional(environment, "REEF_ANTHROPIC_SECRET_NAME") ?? "modelApiKey";
        return new AnthropicProvider({
          apiKey: requiredSecret(secrets, secretName),
          ...(model !== undefined ? { model } : {}),
        });
      }
      if (provider === "bedrock") {
        const secretName =
          optional(environment, "REEF_BEDROCK_SECRET_NAME") ?? "bedrockToken";
        return new BedrockProvider({
          token: requiredSecret(secrets, secretName),
          region: optional(environment, "AWS_REGION") ?? "us-west-2",
          ...(model !== undefined ? { model } : {}),
        });
      }
      if (provider === "bedrock-iam") {
        return new BedrockIamProvider({
          region: optional(environment, "AWS_REGION") ?? "us-west-2",
          ...(model !== undefined ? { model } : {}),
        });
      }
      throw new Error(`unsupported model provider: ${provider}`);
    },
    executor: ({ sandbox }) => new SandboxActionExecutor(sandbox),
    worker: {
      maxTurns: integer(environment, "REEF_AGENT_MAX_TURNS", 24),
      maxTokens: integer(environment, "REEF_AGENT_MAX_OUTPUT_TOKENS", 4_096),
    },
  });
}

export function boolean(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const value = optional(environment, name);
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

export function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = optional(environment, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = optional(environment, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function optional(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function csv(value: string): string[] {
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error("CSV environment value is empty");
  return values;
}

function configString(run: AgentRun, name: string): string | undefined {
  const value = run.config[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function requiredSecret(
  secrets: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = secrets[name];
  if (value === undefined || value === "") {
    throw new Error(`resolved model credential is missing: ${name}`);
  }
  return value;
}
