import { createHash, randomUUID } from "node:crypto";
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
} from "@aws-sdk/client-ecs";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ArtifactStore, RunQueue, SandboxProvisioner } from "../ports.js";
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

export interface EcsSandboxCommandExecutor {
  execute(
    taskArn: string,
    command: SandboxExecution,
  ): Promise<SandboxExecutionResult>;
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
}

class EcsSandboxHandle implements SandboxHandle {
  readonly workspacePath = "/workspace";

  constructor(
    readonly id: string,
    private readonly executor: EcsSandboxCommandExecutor,
  ) {}

  execute(command: SandboxExecution): Promise<SandboxExecutionResult> {
    return this.executor.execute(this.id, {
      ...command,
      env: { ...command.env, AWS_EC2_METADATA_DISABLED: "true" },
    });
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
    this.#options = options;
    this.#client = options.client ?? new ECSClient({});
  }

  async provision(spec: SandboxSpec): Promise<SandboxHandle> {
    const started = await this.#client.send(
      new RunTaskCommand({
        cluster: this.#options.cluster,
        taskDefinition: this.#options.taskDefinition,
        launchType: "FARGATE",
        platformVersion: this.#options.platformVersion ?? "LATEST",
        count: 1,
        enableExecuteCommand: true,
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
    return new EcsSandboxHandle(taskArn, this.#options.commandExecutor);
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
    return new EcsSandboxHandle(sandboxId, this.#options.commandExecutor);
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
