import { existsSync, readFileSync } from "node:fs";
import type {
  SourceBundleStore,
  VerificationArtifactStore,
  VerificationEvidenceStore,
  VerificationQueue,
  VerificationSandboxProvisioner,
  VerificationSecretResolver,
} from "./ports.js";
import { StaticVerificationProfileRegistry, type TrustedVerificationProfileRegistry } from "./profile.js";
import type { TrustedVerificationProfile } from "./types.js";
import {
  LocalSourceBundleStore,
  LocalVerificationArtifactStore,
  LocalVerificationEvidenceStore,
  LocalVerificationSandboxProvisioner,
  DockerVerificationSandboxProvisioner,
  EnvironmentProfileSecretResolver,
} from "./adapters/local.js";
import {
  AwsEcsVerificationSandboxProvisioner,
  AwsS3VerificationArtifactStore,
  AwsS3VerificationEvidenceStore,
  AwsS3VerificationStore,
  AwsSecretsManagerVerificationSecretResolver,
  AwsSqsVerificationQueue,
} from "./adapters/aws.js";
import type {
  PostgresVerificationStore,
  VerificationPostgresConnectionOptions,
} from "./adapters/postgres.js";

export const VERIFICATION_AWS_RDS_GLOBAL_CA_BUNDLE_PATH =
  "/etc/ssl/certs/aws-rds-global-bundle.pem";

export function verificationPostgresConnectionFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): VerificationPostgresConnectionOptions {
  const mode = optional(environment, "REEF_VERIFICATION_DATABASE_SSL_MODE") ?? "disable";
  if (!new Set(["disable", "require", "verify-full"]).has(mode)) {
    throw new Error("REEF_VERIFICATION_DATABASE_SSL_MODE must be disable, require, or verify-full");
  }
  const explicitCa = optional(environment, "REEF_VERIFICATION_DATABASE_CA_FILE");
  const caFile = explicitCa ??
    (mode === "verify-full" && existsSync(VERIFICATION_AWS_RDS_GLOBAL_CA_BUNDLE_PATH)
      ? VERIFICATION_AWS_RDS_GLOBAL_CA_BUNDLE_PATH : undefined);
  if (mode === "verify-full" && caFile === undefined) throw new Error("verify-full requires a PostgreSQL CA file");
  return {
    connectionString: required(environment, "REEF_VERIFICATION_DATABASE_URL"),
    ssl: mode === "disable" ? false : {
      ...(caFile === undefined ? {} : { ca: readFileSync(caFile, "utf8") }),
      rejectUnauthorized: mode === "verify-full",
    },
    max: integer(environment, "REEF_VERIFICATION_DATABASE_POOL_SIZE", 10),
    connectionTimeoutMillis: integer(environment, "REEF_VERIFICATION_DATABASE_CONNECT_TIMEOUT_MS", 5_000),
  };
}

export function loadTrustedVerificationProfiles(
  environment: NodeJS.ProcessEnv = process.env,
): TrustedVerificationProfileRegistry {
  const file = required(environment, "REEF_VERIFICATION_PROFILES_FILE");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("trusted verification profile file must contain a non-empty array");
  return new StaticVerificationProfileRegistry(parsed as TrustedVerificationProfile[]);
}

export function createProductionVerificationQueue(
  store: PostgresVerificationStore,
  environment: NodeJS.ProcessEnv = process.env,
): VerificationQueue {
  const adapter = optional(environment, "REEF_VERIFICATION_QUEUE_ADAPTER") ?? "postgres";
  if (adapter === "postgres") return store;
  if (adapter === "sqs") return new AwsSqsVerificationQueue({
    queueUrl: required(environment, "REEF_VERIFICATION_SQS_QUEUE_URL"),
    waitTimeSeconds: integer(environment, "REEF_VERIFICATION_SQS_WAIT_SECONDS", 10),
  });
  throw new Error(`unsupported verification queue adapter: ${adapter}`);
}

export interface ProductionVerificationObjectStores {
  readonly source: SourceBundleStore;
  readonly artifacts: VerificationArtifactStore;
  readonly evidence: VerificationEvidenceStore;
}

export function createProductionVerificationObjectStores(
  environment: NodeJS.ProcessEnv = process.env,
): ProductionVerificationObjectStores {
  const adapter = optional(environment, "REEF_VERIFICATION_OBJECT_STORE") ?? "s3";
  if (adapter === "s3") {
    const shared = new AwsS3VerificationStore({
      bucket: required(environment, "REEF_VERIFICATION_S3_BUCKET"),
      ...(optional(environment, "REEF_VERIFICATION_S3_PREFIX") === undefined ? {} : { prefix: optional(environment, "REEF_VERIFICATION_S3_PREFIX")! }),
      ...(optional(environment, "REEF_VERIFICATION_S3_KMS_KEY_ID") === undefined ? {} : { kmsKeyId: optional(environment, "REEF_VERIFICATION_S3_KMS_KEY_ID")! }),
    });
    return {
      source: shared,
      artifacts: new AwsS3VerificationArtifactStore(shared),
      evidence: new AwsS3VerificationEvidenceStore(shared),
    };
  }
  if (adapter === "local") {
    if (!boolean(environment, "REEF_VERIFICATION_ALLOW_LOCAL_STORAGE", false)) {
      throw new Error("local verification object storage requires explicit non-production opt-in");
    }
    const root = optional(environment, "REEF_VERIFICATION_DATA_ROOT") ?? "/var/lib/reef-verification";
    return {
      source: new LocalSourceBundleStore(`${root}/source`),
      artifacts: new LocalVerificationArtifactStore(`${root}/artifacts`),
      evidence: new LocalVerificationEvidenceStore(`${root}/evidence`),
    };
  }
  throw new Error(`unsupported verification object store: ${adapter}`);
}

export function createProductionVerificationSecrets(
  environment: NodeJS.ProcessEnv = process.env,
): VerificationSecretResolver {
  const adapter = optional(environment, "REEF_VERIFICATION_SECRET_RESOLVER") ?? "aws-secrets-manager";
  if (adapter === "aws-secrets-manager") return new AwsSecretsManagerVerificationSecretResolver();
  if (adapter === "env") {
    if (!boolean(environment, "REEF_VERIFICATION_ALLOW_ENV_SECRETS", false)) {
      throw new Error("environment secret resolver requires explicit non-production opt-in");
    }
    return new EnvironmentProfileSecretResolver(environment);
  }
  throw new Error(`unsupported verification secret resolver: ${adapter}`);
}

export function createProductionVerificationSandbox(
  environment: NodeJS.ProcessEnv = process.env,
): VerificationSandboxProvisioner {
  const adapter = optional(environment, "REEF_VERIFICATION_SANDBOX_ADAPTER") ?? "ecs";
  const root = optional(environment, "REEF_VERIFICATION_WORKSPACE_ROOT") ?? "/var/lib/reef-verification/workspaces";
  if (adapter === "local") {
    if (!boolean(environment, "REEF_VERIFICATION_ALLOW_UNSAFE_LOCAL_SANDBOX", false)) {
      throw new Error("local verification sandbox is reference-only and requires explicit opt-in");
    }
    return new LocalVerificationSandboxProvisioner(root);
  }
  if (adapter === "docker") return new DockerVerificationSandboxProvisioner({
    root,
    ...(optional(environment, "REEF_VERIFICATION_DOCKER_MEMORY") === undefined ? {} : { memory: optional(environment, "REEF_VERIFICATION_DOCKER_MEMORY")! }),
    ...(optional(environment, "REEF_VERIFICATION_DOCKER_CPUS") === undefined ? {} : { cpus: optional(environment, "REEF_VERIFICATION_DOCKER_CPUS")! }),
  });
  if (adapter === "ecs") return new AwsEcsVerificationSandboxProvisioner({
    cluster: required(environment, "REEF_VERIFICATION_ECS_CLUSTER"),
    taskDefinitionByImageDigest: readStringMap(required(environment, "REEF_VERIFICATION_ECS_TASK_DEFINITIONS_FILE")),
    subnets: csv(required(environment, "REEF_VERIFICATION_ECS_SUBNETS")),
    securityGroups: csv(required(environment, "REEF_VERIFICATION_ECS_SECURITY_GROUPS")),
    runnerSharedSecret: required(environment, "REEF_VERIFICATION_ECS_RUNNER_SHARED_SECRET"),
    containerName: optional(environment, "REEF_VERIFICATION_ECS_CONTAINER_NAME") ?? "verification-sandbox",
    platformVersion: optional(environment, "REEF_VERIFICATION_ECS_PLATFORM_VERSION") ?? "LATEST",
    port: integer(environment, "REEF_VERIFICATION_ECS_RUNNER_PORT", 8081),
  });
  throw new Error(`unsupported verification sandbox adapter: ${adapter}`);
}

export function boolean(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = optional(environment, name); if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true; if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

export function integer(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = optional(environment, name); if (raw === undefined) return fallback;
  const value = Number(raw); if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`); return value;
}

function readStringMap(file: string): Readonly<Record<string, string>> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("ECS task definition map must be an object");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^sha256:[0-9a-f]{64}$/.test(key) || typeof item !== "string" || item === "") throw new Error("ECS task definition map is invalid");
    result[key] = item;
  }
  return result;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = optional(environment, name); if (value === undefined) throw new Error(`${name} is required`); return value;
}
function optional(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]; return value === undefined || value.trim() === "" ? undefined : value.trim();
}
function csv(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean); if (values.length === 0) throw new Error("CSV configuration is empty"); return values;
}
