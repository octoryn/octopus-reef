import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type {
  ArtifactStore,
  RunQueue,
  SandboxProvisioner,
  SecretResolver,
} from "../ports.js";
import type {
  ArtifactRef,
  QueueClaimOptions,
  QueueLease,
  QueueMessage,
  SandboxExecution,
  SandboxExecutionResult,
  SandboxHandle,
  SandboxSpec,
  TenantScope,
} from "../types.js";

export interface AwsSqsRunQueueOptions {
  readonly queueUrl: string;
  readonly client?: SQSClient;
  readonly waitTimeSeconds?: number;
  readonly now?: () => string;
}

/** At-least-once SQS transport; repository fencing supplies execution ownership. */
export class AwsSqsRunQueue implements RunQueue {
  readonly #queueUrl: string;
  readonly #client: SQSClient;
  readonly #waitTimeSeconds: number;
  readonly #now: () => string;

  constructor(options: AwsSqsRunQueueOptions) {
    this.#queueUrl = options.queueUrl;
    this.#client = options.client ?? new SQSClient({});
    this.#waitTimeSeconds = options.waitTimeSeconds ?? 10;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async enqueue(
    scope: TenantScope,
    runId: string,
    options: { readonly delayMs?: number; readonly attempt?: number } = {},
  ): Promise<void> {
    const message: QueueMessage = {
      ...scope,
      id: randomUUID(),
      runId,
      attempt: options.attempt ?? 0,
      availableAt: new Date(
        Date.parse(this.#now()) + (options.delayMs ?? 0),
      ).toISOString(),
    };
    await this.#client.send(
      new SendMessageCommand({
        QueueUrl: this.#queueUrl,
        MessageBody: JSON.stringify(message),
        DelaySeconds: Math.min(900, Math.ceil((options.delayMs ?? 0) / 1000)),
      }),
    );
  }

  async claim(options: QueueClaimOptions): Promise<QueueLease | undefined> {
    const result = await this.#client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.#queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.#waitTimeSeconds,
        VisibilityTimeout: seconds(options.leaseMs),
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    const raw = result.Messages?.[0];
    if (raw?.Body === undefined || raw.ReceiptHandle === undefined)
      return undefined;
    const message = parseQueueMessage(raw.Body);
    const receiveCount = Number(
      raw.Attributes?.["ApproximateReceiveCount"] ?? "1",
    );
    return {
      message: {
        ...message,
        attempt: Math.max(message.attempt, receiveCount - 1),
      },
      receipt: raw.ReceiptHandle,
      ownerId: options.workerId,
      fencingToken: Math.max(1, receiveCount),
      expiresAt: new Date(
        Date.parse(options.now) + options.leaseMs,
      ).toISOString(),
    };
  }

  async heartbeat(lease: QueueLease, expiresAt: string): Promise<boolean> {
    try {
      await this.#client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.#queueUrl,
          ReceiptHandle: lease.receipt,
          VisibilityTimeout: Math.max(
            0,
            seconds(Date.parse(expiresAt) - Date.parse(this.#now())),
          ),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async ack(lease: QueueLease): Promise<void> {
    await this.#client.send(
      new DeleteMessageCommand({
        QueueUrl: this.#queueUrl,
        ReceiptHandle: lease.receipt,
      }),
    );
  }

  async retry(lease: QueueLease, availableAt: string): Promise<void> {
    await this.#client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.#queueUrl,
        ReceiptHandle: lease.receipt,
        VisibilityTimeout: Math.min(
          43_200,
          Math.max(
            0,
            seconds(Date.parse(availableAt) - Date.parse(this.#now())),
          ),
        ),
      }),
    );
  }
}

export interface AwsS3ArtifactStoreOptions {
  readonly bucket: string;
  readonly prefix?: string;
  readonly client?: S3Client;
  readonly kmsKeyId?: string;
}

export class AwsS3ArtifactStore implements ArtifactStore {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #client: S3Client;
  readonly #kmsKeyId: string | undefined;

  constructor(options: AwsS3ArtifactStoreOptions) {
    this.#bucket = options.bucket;
    this.#prefix = options.prefix?.replace(/^\/+|\/+$/g, "") ?? "reef-runs";
    this.#client = options.client ?? new S3Client({});
    this.#kmsKeyId = options.kmsKeyId;
  }

  async put(
    scope: TenantScope,
    runId: string,
    key: string,
    content: Uint8Array,
    contentType?: string,
  ): Promise<ArtifactRef> {
    const objectKey = this.#key(scope, runId, key);
    const sha256 = createHash("sha256").update(content).digest("hex");
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        Body: content,
        ...(contentType !== undefined ? { ContentType: contentType } : {}),
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        ServerSideEncryption:
          this.#kmsKeyId === undefined ? "AES256" : "aws:kms",
        ...(this.#kmsKeyId !== undefined
          ? { SSEKMSKeyId: this.#kmsKeyId }
          : {}),
        Metadata: {
          organisation: tenantHash(scope.organisationId),
          project: tenantHash(scope.projectId),
          run: runId,
        },
      }),
    );
    return {
      ...scope,
      runId,
      key,
      uri: `s3://${this.#bucket}/${objectKey}`,
      size: content.byteLength,
      sha256,
    };
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    const expected = `s3://${this.#bucket}/`;
    if (!ref.uri.startsWith(expected))
      throw new Error("artifact bucket mismatch");
    const result = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: ref.uri.slice(expected.length),
      }),
    );
    if (result.Body === undefined) throw new Error("S3 artifact has no body");
    const content = await result.Body.transformToByteArray();
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== ref.sha256) throw new Error("S3 artifact checksum mismatch");
    return content;
  }

  #key(scope: TenantScope, runId: string, key: string): string {
    if (
      key.length === 0 ||
      key.startsWith("/") ||
      key.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new Error(`invalid artifact key: ${key}`);
    }
    return [
      this.#prefix,
      `org=${tenantHash(scope.organisationId)}`,
      `project=${tenantHash(scope.projectId)}`,
      `run=${encodeURIComponent(runId)}`,
      key,
    ].join("/");
  }
}

export interface AwsSecretsManagerResolverOptions {
  readonly client?: SecretsManagerClient;
}

/**
 * Resolves `aws-secretsmanager://<encoded-secret-id>[#json-field]` only after a
 * worker owns the fenced run lease. Secret values never enter run persistence.
 */
export class AwsSecretsManagerSecretResolver implements SecretResolver {
  readonly #client: SecretsManagerClient;

  constructor(options: AwsSecretsManagerResolverOptions = {}) {
    this.#client = options.client ?? new SecretsManagerClient({});
  }

  async resolve(
    _scope: TenantScope,
    refs: readonly { readonly name: string; readonly secretRef: string }[],
  ): Promise<Readonly<Record<string, string>>> {
    const fetched = new Map<string, string>();
    const resolved: Record<string, string> = {};
    for (const ref of refs) {
      const parsed = parseSecretsManagerRef(ref.secretRef);
      let secret = fetched.get(parsed.secretId);
      if (secret === undefined) {
        const result = await this.#client.send(
          new GetSecretValueCommand({ SecretId: parsed.secretId }),
        );
        secret =
          result.SecretString ??
          (result.SecretBinary === undefined
            ? undefined
            : Buffer.from(result.SecretBinary).toString("utf8"));
        if (secret === undefined) {
          throw new Error(`Secrets Manager value is empty: ${ref.secretRef}`);
        }
        fetched.set(parsed.secretId, secret);
      }
      resolved[ref.name] =
        parsed.field === undefined
          ? secret
          : jsonSecretField(secret, parsed.field, ref.secretRef);
    }
    return resolved;
  }
}

export interface EcsSandboxCommandExecutor {
  execute(
    taskArn: string,
    command: SandboxExecution,
    context?: EcsSandboxCommandContext,
  ): Promise<SandboxExecutionResult>;
  ready?(taskArn: string, context?: EcsSandboxCommandContext): Promise<void>;
}

export interface EcsSandboxCommandContext {
  readonly authToken?: string;
}

export interface HttpEcsSandboxCommandExecutorOptions {
  /** Private command bridge accepting `{ taskArn, command }`. */
  readonly endpoint: string;
  readonly bearerToken?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Reference bridge for ECS Exec/SSM sidecars or a private task command API. */
export class HttpEcsSandboxCommandExecutor implements EcsSandboxCommandExecutor {
  readonly #options: HttpEcsSandboxCommandExecutorOptions;

  constructor(options: HttpEcsSandboxCommandExecutorOptions) {
    this.#options = options;
  }

  async execute(
    taskArn: string,
    command: SandboxExecution,
    context: EcsSandboxCommandContext = {},
  ): Promise<SandboxExecutionResult> {
    return executeSandboxRequest(
      this.#options.fetchImpl ?? fetch,
      this.#options.endpoint,
      { taskArn, command },
      this.#options.bearerToken ?? context.authToken,
      command.timeoutMs,
    );
  }
}

export interface AwsEcsTaskHttpCommandExecutorOptions {
  readonly cluster: string;
  readonly client?: ECSClient;
  readonly port?: number;
  readonly path?: string;
  readonly scheme?: "http" | "https";
  readonly fetchImpl?: typeof fetch;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
}

/** Connects the Worker directly to the private command runner in each task. */
export class AwsEcsTaskHttpCommandExecutor implements EcsSandboxCommandExecutor {
  readonly #options: AwsEcsTaskHttpCommandExecutorOptions;
  readonly #client: ECSClient;

  constructor(options: AwsEcsTaskHttpCommandExecutorOptions) {
    this.#options = options;
    this.#client = options.client ?? new ECSClient({});
  }

  async execute(
    taskArn: string,
    command: SandboxExecution,
    context: EcsSandboxCommandContext = {},
  ): Promise<SandboxExecutionResult> {
    const endpoint = await this.#endpoint(taskArn);
    return executeSandboxRequest(
      this.#options.fetchImpl ?? fetch,
      endpoint,
      { command },
      context.authToken,
      command.timeoutMs,
    );
  }

  async ready(
    taskArn: string,
    _context: EcsSandboxCommandContext = {},
  ): Promise<void> {
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? 60_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const endpoint = await this.#endpoint(taskArn);
        const readyUrl = new URL(endpoint);
        readyUrl.pathname = "/readyz";
        const response = await (this.#options.fetchImpl ?? fetch)(readyUrl, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
        lastError = new Error(`sandbox runner readiness ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.#options.pollMs ?? 500),
      );
    }
    throw new Error(
      `sandbox runner did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async #endpoint(taskArn: string): Promise<string> {
    const result = await this.#client.send(
      new DescribeTasksCommand({
        cluster: this.#options.cluster,
        tasks: [taskArn],
      }),
    );
    const task = result.tasks?.[0];
    if (task?.lastStatus !== "RUNNING") {
      throw new Error(
        `ECS sandbox is not running: ${task?.lastStatus ?? "missing"}`,
      );
    }
    const address = ecsPrivateIpv4(task);
    return `${this.#options.scheme ?? "http"}://${address}:${this.#options.port ?? 8081}${this.#options.path ?? "/v1/execute"}`;
  }
}

export interface AwsEcsSandboxOptions {
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly subnets: readonly string[];
  readonly securityGroups: readonly string[];
  readonly commandExecutor: EcsSandboxCommandExecutor;
  readonly client?: ECSClient;
  readonly containerName?: string;
  readonly platformVersion?: string;
  readonly launchTimeoutMs?: number;
  readonly pollMs?: number;
  /** Shared EFS mount path visible to both worker and sandbox tasks. */
  readonly workspaceRoot?: string;
  /** HMAC source used to derive one stable bearer token per AgentRun attempt. */
  readonly runnerSharedSecret?: string;
  /** Workspace path inside the sandbox task/container. */
  readonly runnerWorkspacePath?: string;
  /** Legacy bridge deployments may opt into ECS Exec; direct runners do not. */
  readonly enableExecuteCommand?: boolean;
}

class EcsSandboxHandle implements SandboxHandle {
  constructor(
    readonly id: string,
    readonly workspacePath: string,
    private readonly executor: EcsSandboxCommandExecutor,
    private readonly authToken: string | undefined,
  ) {}

  execute(command: SandboxExecution): Promise<SandboxExecutionResult> {
    return this.executor.execute(
      this.id,
      {
        ...command,
        env: { ...command.env, AWS_EC2_METADATA_DISABLED: "true" },
      },
      this.authToken === undefined ? {} : { authToken: this.authToken },
    );
  }
}

/** Fargate reference adapter; networking remains private and IMDS is disabled. */
export class AwsEcsFargateSandboxProvisioner implements SandboxProvisioner {
  readonly #options: AwsEcsSandboxOptions;
  readonly #client: ECSClient;

  constructor(options: AwsEcsSandboxOptions) {
    if (options.subnets.length === 0)
      throw new Error("private subnets are required");
    if (options.securityGroups.length === 0) {
      throw new Error("a deny-by-default sandbox security group is required");
    }
    if (
      options.runnerSharedSecret !== undefined &&
      Buffer.byteLength(options.runnerSharedSecret, "utf8") < 32
    ) {
      throw new Error(
        "ECS runner shared secret must contain at least 32 bytes",
      );
    }
    this.#options = options;
    this.#client = options.client ?? new ECSClient({});
  }

  async provision(spec: SandboxSpec): Promise<SandboxHandle> {
    const workspacePath = ecsWorkspacePath(
      this.#options.workspaceRoot ?? "/workspace",
      spec,
    );
    const authToken = sandboxAuthToken(this.#options.runnerSharedSecret, spec);
    const started = await this.#client.send(
      new RunTaskCommand({
        cluster: this.#options.cluster,
        taskDefinition: this.#options.taskDefinition,
        launchType: "FARGATE",
        platformVersion: this.#options.platformVersion ?? "LATEST",
        count: 1,
        enableExecuteCommand: this.#options.enableExecuteCommand ?? false,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [...this.#options.subnets],
            securityGroups: [...this.#options.securityGroups],
            assignPublicIp: "DISABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: this.#options.containerName ?? "agent",
              environment: [
                { name: "AWS_EC2_METADATA_DISABLED", value: "true" },
                { name: "REEF_ORGANISATION_ID", value: spec.organisationId },
                { name: "REEF_PROJECT_ID", value: spec.projectId },
                { name: "REEF_RUN_ID", value: spec.runId },
                { name: "REEF_PROJECT_REF", value: spec.projectRef },
                { name: "REEF_WORKSPACE_PATH", value: workspacePath },
                {
                  name: "REEF_SANDBOX_WORKSPACE",
                  value: this.#options.runnerWorkspacePath ?? "/workspace",
                },
                ...(authToken === undefined
                  ? []
                  : [{ name: "REEF_SANDBOX_AUTH_TOKEN", value: authToken }]),
                ...(spec.sourceBinding === undefined
                  ? []
                  : [
                      {
                        name: "REEF_SOURCE_BINDING",
                        value: JSON.stringify(spec.sourceBinding),
                      },
                    ]),
              ],
            },
          ],
        },
        tags: [
          { key: "reef:organisation", value: tenantHash(spec.organisationId) },
          { key: "reef:project", value: tenantHash(spec.projectId) },
          { key: "reef:run", value: spec.runId.slice(0, 256) },
        ],
      }),
    );
    const taskArn = started.tasks?.[0]?.taskArn;
    if (taskArn === undefined) {
      throw new Error(
        `ECS RunTask failed: ${started.failures?.map((f) => f.reason).join(", ")}`,
      );
    }
    await this.#waitUntilRunning(taskArn);
    await this.#options.commandExecutor.ready?.(
      taskArn,
      authToken === undefined ? {} : { authToken },
    );
    return new EcsSandboxHandle(
      taskArn,
      workspacePath,
      this.#options.commandExecutor,
      authToken,
    );
  }

  async restore(
    _spec: SandboxSpec,
    sandboxId: string,
  ): Promise<SandboxHandle | undefined> {
    const result = await this.#client.send(
      new DescribeTasksCommand({
        cluster: this.#options.cluster,
        tasks: [sandboxId],
      }),
    );
    if (result.tasks?.[0]?.lastStatus !== "RUNNING") return undefined;
    const authToken = sandboxAuthToken(this.#options.runnerSharedSecret, _spec);
    await this.#options.commandExecutor.ready?.(
      sandboxId,
      authToken === undefined ? {} : { authToken },
    );
    return new EcsSandboxHandle(
      sandboxId,
      ecsWorkspacePath(this.#options.workspaceRoot ?? "/workspace", _spec),
      this.#options.commandExecutor,
      authToken,
    );
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.#client.send(
      new StopTaskCommand({
        cluster: this.#options.cluster,
        task: handle.id,
        reason: "Reef AgentRun finished",
      }),
    );
  }

  async #waitUntilRunning(taskArn: string): Promise<void> {
    const deadline = Date.now() + (this.#options.launchTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      const result = await this.#client.send(
        new DescribeTasksCommand({
          cluster: this.#options.cluster,
          tasks: [taskArn],
        }),
      );
      const task = result.tasks?.[0];
      if (task?.lastStatus === "RUNNING") return;
      if (task?.lastStatus === "STOPPED") {
        throw new Error(
          `ECS sandbox stopped: ${task.stoppedReason ?? "unknown"}`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.#options.pollMs ?? 1_000),
      );
    }
    throw new Error(`timed out waiting for ECS sandbox ${taskArn}`);
  }
}

async function executeSandboxRequest(
  fetchImpl: typeof fetch,
  endpoint: string,
  payload: unknown,
  bearerToken: string | undefined,
  timeoutMs: number | undefined,
): Promise<SandboxExecutionResult> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearerToken !== undefined
        ? { Authorization: `Bearer ${bearerToken}` }
        : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs ?? 15 * 60_000),
  });
  const body = (await response.json()) as Partial<SandboxExecutionResult> & {
    readonly error?: unknown;
  };
  if (
    !response.ok ||
    typeof body.exitCode !== "number" ||
    typeof body.stdout !== "string" ||
    typeof body.stderr !== "string"
  ) {
    throw new Error(
      `ECS sandbox command bridge failed: ${response.status} ${JSON.stringify(body).slice(0, 500)}`,
    );
  }
  return body as SandboxExecutionResult;
}

function ecsPrivateIpv4(task: Task): string {
  for (const attachment of task.attachments ?? []) {
    const address = attachment.details?.find(
      (detail) => detail.name === "privateIPv4Address",
    )?.value;
    if (address !== undefined && address !== "") return address;
  }
  for (const container of task.containers ?? []) {
    const address = container.networkInterfaces?.[0]?.privateIpv4Address;
    if (address !== undefined && address !== "") return address;
  }
  throw new Error("ECS sandbox task has no private IPv4 address");
}

function sandboxAuthToken(
  sharedSecret: string | undefined,
  spec: SandboxSpec,
): string | undefined {
  if (sharedSecret === undefined) return undefined;
  return createHmac("sha256", sharedSecret)
    .update(
      [
        spec.organisationId,
        spec.projectId,
        spec.runId,
        String(spec.attempt),
      ].join("\0"),
    )
    .digest("base64url");
}

function parseQueueMessage(body: string): QueueMessage {
  const value = JSON.parse(body) as Partial<QueueMessage>;
  for (const key of [
    "id",
    "runId",
    "organisationId",
    "projectId",
    "availableAt",
  ] as const) {
    if (typeof value[key] !== "string" || value[key] === "") {
      throw new Error(`invalid SQS run message: ${key}`);
    }
  }
  if (typeof value.attempt !== "number" || value.attempt < 0) {
    throw new Error("invalid SQS run message: attempt");
  }
  return value as QueueMessage;
}

function seconds(milliseconds: number): number {
  return Math.max(0, Math.min(43_200, Math.ceil(milliseconds / 1_000)));
}

function tenantHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function ecsWorkspacePath(root: string, spec: SandboxSpec): string {
  const cleanRoot = root.replace(/\/+$/, "");
  const safeRun = encodeURIComponent(spec.runId).replaceAll("%", "_");
  return `${cleanRoot}/org-${tenantHash(spec.organisationId)}/project-${tenantHash(spec.projectId)}/run-${safeRun}`;
}

function parseSecretsManagerRef(secretRef: string): {
  readonly secretId: string;
  readonly field?: string;
} {
  const prefixes = ["aws-secretsmanager://", "aws-secrets://"];
  const prefix = prefixes.find((candidate) => secretRef.startsWith(candidate));
  if (prefix === undefined) {
    throw new Error(`unsupported Secrets Manager secretRef: ${secretRef}`);
  }
  const raw = secretRef.slice(prefix.length);
  const hash = raw.indexOf("#");
  const secretId = decodeURIComponent(hash < 0 ? raw : raw.slice(0, hash));
  const field = hash < 0 ? undefined : decodeURIComponent(raw.slice(hash + 1));
  if (secretId === "" || field === "") {
    throw new Error(`invalid Secrets Manager secretRef: ${secretRef}`);
  }
  return {
    secretId,
    ...(field !== undefined ? { field } : {}),
  };
}

function jsonSecretField(
  secret: string,
  field: string,
  secretRef: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret) as unknown;
  } catch {
    throw new Error(`Secrets Manager value is not JSON: ${secretRef}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Secrets Manager value is not an object: ${secretRef}`);
  }
  const value = (parsed as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    throw new Error(`Secrets Manager JSON field is not a string: ${secretRef}`);
  }
  return value;
}
