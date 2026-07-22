import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand,
  SendMessageCommand, SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DescribeTasksCommand, ECSClient, RunTaskCommand, StopTaskCommand, type Task,
} from "@aws-sdk/client-ecs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { canonicalHash, verifyEvidence, type Evidence } from "octopus-evidence";
import type {
  SourceBundleStore,
  VerificationArtifactStore,
  VerificationEvidenceStore,
  VerificationQueue,
  VerificationSandboxProvisioner,
  VerificationSecretResolver,
} from "../ports.js";
import type {
  SourceBundleDescriptor,
  VerificationArtifact,
  VerificationCheckDefinition,
  VerificationCommandResult,
  VerificationQueueLease,
  VerificationQueueMessage,
  VerificationSandbox,
  VerificationSandboxSpec,
  VerificationTenant,
} from "../types.js";

export interface AwsSqsVerificationQueueOptions {
  readonly queueUrl: string;
  readonly client?: SQSClient;
  readonly waitTimeSeconds?: number;
  readonly now?: () => string;
}

/** At-least-once SQS transport. PostgreSQL run fencing owns execution safety. */
export class AwsSqsVerificationQueue implements VerificationQueue {
  readonly #options: AwsSqsVerificationQueueOptions;
  readonly #client: SQSClient;
  readonly #now: () => string;

  constructor(options: AwsSqsVerificationQueueOptions) {
    this.#options = options;
    this.#client = options.client ?? new SQSClient({});
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async enqueue(
    tenant: VerificationTenant,
    runRef: string,
    attempt: number,
    delayMs = 0,
  ): Promise<void> {
    const message: VerificationQueueMessage = {
      ...tenant, id: randomUUID(), runRef, attempt,
      availableAt: new Date(Date.parse(this.#now()) + delayMs).toISOString(),
    };
    await this.#client.send(new SendMessageCommand({
      QueueUrl: this.#options.queueUrl,
      MessageBody: JSON.stringify(message),
      DelaySeconds: Math.min(900, Math.ceil(delayMs / 1000)),
    }));
  }

  async claim(
    workerId: string,
    leaseMs: number,
    now: string,
  ): Promise<VerificationQueueLease | undefined> {
    const result = await this.#client.send(new ReceiveMessageCommand({
      QueueUrl: this.#options.queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: this.#options.waitTimeSeconds ?? 10,
      VisibilityTimeout: seconds(leaseMs),
    }));
    const raw = result.Messages?.[0];
    if (raw?.Body === undefined || raw.ReceiptHandle === undefined) return undefined;
    return {
      message: parseMessage(raw.Body), receipt: raw.ReceiptHandle, ownerId: workerId,
      expiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
    };
  }

  async heartbeat(lease: VerificationQueueLease, expiresAt: string): Promise<boolean> {
    try {
      await this.#client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.#options.queueUrl, ReceiptHandle: lease.receipt,
        VisibilityTimeout: seconds(Date.parse(expiresAt) - Date.parse(this.#now())),
      }));
      return true;
    } catch { return false; }
  }

  async ack(lease: VerificationQueueLease): Promise<void> {
    await this.#client.send(new DeleteMessageCommand({
      QueueUrl: this.#options.queueUrl, ReceiptHandle: lease.receipt,
    }));
  }

  async retry(lease: VerificationQueueLease, availableAt: string): Promise<void> {
    await this.#client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.#options.queueUrl, ReceiptHandle: lease.receipt,
      VisibilityTimeout: seconds(Date.parse(availableAt) - Date.parse(this.#now())),
    }));
  }
}

export interface AwsS3VerificationStoreOptions {
  readonly bucket: string;
  readonly prefix?: string;
  readonly client?: S3Client;
  readonly kmsKeyId?: string;
}

/** Tenant-partitioned source, bounded output artifact, and Evidence store. */
export class AwsS3VerificationStore implements SourceBundleStore {
  readonly #options: AwsS3VerificationStoreOptions;
  readonly #client: S3Client;
  readonly #prefix: string;

  constructor(options: AwsS3VerificationStoreOptions) {
    this.#options = options;
    this.#client = options.client ?? new S3Client({});
    this.#prefix = options.prefix?.replace(/^\/+|\/+$/g, "") ?? "reef-verification";
  }

  async descriptor(
    tenant: VerificationTenant,
    sourceBundleRef: string,
  ): Promise<SourceBundleDescriptor> {
    const bytes = await this.#get(this.#key(tenant, "source-descriptors", hash(sourceBundleRef)));
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as SourceBundleDescriptor;
  }

  content(tenant: VerificationTenant, contentRef: string): Promise<Uint8Array> {
    return this.#get(this.#key(tenant, "source-objects", hash(contentRef)));
  }

  async putArtifact(
    tenant: VerificationTenant,
    runRef: string,
    kind: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<VerificationArtifact> {
    const digestValue = sha256(content);
    const ref = `artifact:${hash(`${tenantKey(tenant)}\0${runRef}\0${kind}\0${digestValue}`)}`;
    await this.#put(this.#key(tenant, "artifacts", hash(ref)), content, mediaType);
    return { ref, digest: digestValue, kind, mediaType, size: content.byteLength };
  }

  async getArtifact(
    tenant: VerificationTenant,
    ref: string,
  ): Promise<Uint8Array | undefined> {
    try {
      return await this.#get(this.#key(tenant, "artifacts", hash(ref)));
    } catch (error) {
      if (awsNotFound(error)) return undefined;
      throw error;
    }
  }

  async putEvidence(
    tenant: VerificationTenant,
    evidence: Evidence,
  ): Promise<{ readonly ref: string; readonly digest: string }> {
    if (!verifyEvidence(evidence)) throw new Error("refusing invalid Evidence");
    const digestValue = `sha256:${canonicalHash(evidence as never)}`;
    const ref = `evidence:${evidence.id}`;
    await this.#put(
      this.#key(tenant, "evidence", hash(ref)),
      Buffer.from(JSON.stringify({ evidence, digest: digestValue }), "utf8"),
      "application/json",
    );
    return { ref, digest: digestValue };
  }

  async getEvidence(
    tenant: VerificationTenant,
    ref: string,
  ): Promise<{ readonly evidence: Evidence; readonly digest: string } | undefined> {
    try {
      const bytes = await this.#get(this.#key(tenant, "evidence", hash(ref)));
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as { evidence: Evidence; digest: string };
    } catch (error) {
      if (awsNotFound(error)) return undefined;
      throw error;
    }
  }

  async putSourceBundle(
    descriptor: SourceBundleDescriptor,
    content: Readonly<Record<string, Uint8Array>>,
  ): Promise<void> {
    const tenant: VerificationTenant = descriptor;
    for (const [ref, bytes] of Object.entries(content)) {
      await this.#put(this.#key(tenant, "source-objects", hash(ref)), bytes, "application/octet-stream");
    }
    await this.#put(
      this.#key(tenant, "source-descriptors", hash(descriptor.sourceBundleRef)),
      Buffer.from(JSON.stringify(descriptor), "utf8"),
      "application/json",
    );
  }

  async #put(key: string, content: Uint8Array, mediaType: string): Promise<void> {
    const checksum = createHash("sha256").update(content).digest();
    await this.#client.send(new PutObjectCommand({
      Bucket: this.#options.bucket, Key: key, Body: content, ContentType: mediaType,
      ChecksumSHA256: checksum.toString("base64"),
      ServerSideEncryption: this.#options.kmsKeyId === undefined ? "AES256" : "aws:kms",
      ...(this.#options.kmsKeyId === undefined ? {} : { SSEKMSKeyId: this.#options.kmsKeyId }),
    }));
  }

  async #get(key: string): Promise<Uint8Array> {
    const result = await this.#client.send(new GetObjectCommand({ Bucket: this.#options.bucket, Key: key }));
    if (result.Body === undefined) throw new Error("S3 verification object has no body");
    return result.Body.transformToByteArray();
  }

  #key(tenant: VerificationTenant, area: string, object: string): string {
    return `${this.#prefix}/org=${hash(tenant.organisationRef).slice(0, 32)}/project=${hash(tenant.projectRef).slice(0, 32)}/${area}/${object}`;
  }
}

export class AwsS3VerificationArtifactStore implements VerificationArtifactStore {
  readonly #store: AwsS3VerificationStore;
  constructor(options: AwsS3VerificationStoreOptions | AwsS3VerificationStore) {
    this.#store = options instanceof AwsS3VerificationStore ? options : new AwsS3VerificationStore(options);
  }
  put(
    tenant: VerificationTenant,
    runRef: string,
    kind: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<VerificationArtifact> {
    return this.#store.putArtifact(tenant, runRef, kind, mediaType, content);
  }
  get(tenant: VerificationTenant, ref: string): Promise<Uint8Array | undefined> {
    return this.#store.getArtifact(tenant, ref);
  }
}

export class AwsS3VerificationEvidenceStore implements VerificationEvidenceStore {
  readonly #store: AwsS3VerificationStore;
  constructor(options: AwsS3VerificationStoreOptions | AwsS3VerificationStore) {
    this.#store = options instanceof AwsS3VerificationStore ? options : new AwsS3VerificationStore(options);
  }
  put(tenant: VerificationTenant, evidence: Evidence): Promise<{ ref: string; digest: string }> {
    return this.#store.putEvidence(tenant, evidence);
  }
  get(
    tenant: VerificationTenant,
    ref: string,
  ): Promise<{ evidence: Evidence; digest: string } | undefined> {
    return this.#store.getEvidence(tenant, ref);
  }
}

export class AwsSecretsManagerVerificationSecretResolver implements VerificationSecretResolver {
  readonly #client: SecretsManagerClient;
  constructor(client: SecretsManagerClient = new SecretsManagerClient({})) { this.#client = client; }

  async resolve(
    _tenant: VerificationTenant,
    bindings: readonly { name: string; secretRef: string; environmentName: string }[],
  ): Promise<Readonly<Record<string, string>>> {
    const cache = new Map<string, string>(); const result: Record<string, string> = {};
    for (const binding of bindings) {
      const parsed = parseSecretRef(binding.secretRef);
      let secret = cache.get(parsed.id);
      if (secret === undefined) {
        const value = await this.#client.send(new GetSecretValueCommand({ SecretId: parsed.id }));
        secret = value.SecretString ?? (value.SecretBinary === undefined ? undefined : Buffer.from(value.SecretBinary).toString("utf8"));
        if (secret === undefined) throw new Error(`verification profile secret is empty: ${binding.name}`);
        cache.set(parsed.id, secret);
      }
      result[binding.environmentName] = parsed.field === undefined ? secret : jsonField(secret, parsed.field);
    }
    return result;
  }
}

export interface AwsEcsVerificationSandboxOptions {
  readonly cluster: string;
  /** Server-configured image-digest to immutable task-definition mapping. */
  readonly taskDefinitionByImageDigest: Readonly<Record<string, string>>;
  readonly subnets: readonly string[];
  readonly securityGroups: readonly string[];
  readonly runnerSharedSecret: string;
  readonly client?: ECSClient;
  readonly containerName?: string;
  readonly port?: number;
  readonly fetchImpl?: typeof fetch;
  readonly platformVersion?: string;
  readonly launchTimeoutMs?: number;
  readonly pollMs?: number;
}

class EcsVerificationSandbox implements VerificationSandbox {
  readonly workspacePath = "/workspace";
  constructor(
    readonly id: string,
    private readonly endpoint: string,
    private readonly authToken: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async writeFile(path: string, content: Uint8Array, signal: AbortSignal): Promise<void> {
    const result = await request(this.fetchImpl, `${this.endpoint}/v1/files/write`, this.authToken,
      { path, contentBase64: Buffer.from(content).toString("base64") }, signal);
    if (typeof result !== "object" || result === null || !("written" in result)) throw new Error("ECS sandbox write response is invalid");
  }

  async execute(
    check: VerificationCheckDefinition,
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<VerificationCommandResult> {
    const value = await request(this.fetchImpl, `${this.endpoint}/v1/execute`, this.authToken, {
      argv: check.argv, workingDirectory: check.workingDirectory, timeoutMs: check.timeoutMs,
      outputLimitBytes: check.outputLimitBytes, environment,
    }, signal) as Record<string, unknown>;
    if (typeof value["exitCode"] !== "number" || typeof value["stdoutBase64"] !== "string" ||
      typeof value["stderrBase64"] !== "string" || typeof value["timedOut"] !== "boolean") {
      throw new Error("ECS sandbox execution response is invalid");
    }
    return {
      exitCode: value["exitCode"], stdout: Buffer.from(value["stdoutBase64"], "base64"),
      stderr: Buffer.from(value["stderrBase64"], "base64"), timedOut: value["timedOut"],
    };
  }

  async readFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | undefined> {
    const value = await request(this.fetchImpl, `${this.endpoint}/v1/files/read`, this.authToken,
      { path, maxBytes }, signal) as Record<string, unknown>;
    if (value["found"] === false) return undefined;
    if (value["found"] !== true || typeof value["contentBase64"] !== "string") throw new Error("ECS sandbox read response is invalid");
    return Buffer.from(value["contentBase64"], "base64");
  }
}

/** Private-subnet Fargate sandbox. Task definitions are allowlisted by profile image digest. */
export class AwsEcsVerificationSandboxProvisioner implements VerificationSandboxProvisioner {
  readonly #options: AwsEcsVerificationSandboxOptions;
  readonly #client: ECSClient;
  constructor(options: AwsEcsVerificationSandboxOptions) {
    if (options.subnets.length === 0 || options.securityGroups.length === 0) throw new Error("private subnets and deny-by-default security groups are required");
    if (Buffer.byteLength(options.runnerSharedSecret, "utf8") < 32) throw new Error("runner shared secret must contain at least 32 bytes");
    this.#options = options; this.#client = options.client ?? new ECSClient({});
  }

  async provision(spec: VerificationSandboxSpec, signal: AbortSignal): Promise<VerificationSandbox> {
    const taskDefinition = this.#options.taskDefinitionByImageDigest[spec.imageDigest];
    if (taskDefinition === undefined) throw new Error("profile sandbox image digest is not registered for ECS");
    const token = authToken(this.#options.runnerSharedSecret, spec);
    const started = await this.#client.send(new RunTaskCommand({
      cluster: this.#options.cluster, taskDefinition, launchType: "FARGATE",
      platformVersion: this.#options.platformVersion ?? "LATEST", count: 1,
      enableExecuteCommand: false,
      networkConfiguration: { awsvpcConfiguration: {
        subnets: [...this.#options.subnets], securityGroups: [...this.#options.securityGroups], assignPublicIp: "DISABLED",
      } },
      overrides: { containerOverrides: [{ name: this.#options.containerName ?? "verification-sandbox", environment: [
        { name: "AWS_EC2_METADATA_DISABLED", value: "true" },
        { name: "REEF_VERIFICATION_SANDBOX_WORKSPACE", value: "/workspace" },
        { name: "REEF_VERIFICATION_RUN_REF", value: spec.runRef },
        { name: "REEF_VERIFICATION_ATTEMPT", value: String(spec.attempt) },
        { name: "REEF_VERIFICATION_IMAGE_DIGEST", value: spec.imageDigest },
      ] }] },
      tags: [
        { key: "reef:organisation", value: hash(spec.organisationRef).slice(0, 24) },
        { key: "reef:project", value: hash(spec.projectRef).slice(0, 24) },
        { key: "reef:verification", value: hash(spec.runRef).slice(0, 24) },
      ],
    }), { abortSignal: signal });
    const taskArn = started.tasks?.[0]?.taskArn;
    if (taskArn === undefined) throw new Error(`ECS verification sandbox failed to start: ${started.failures?.map((item) => item.reason).join(", ")}`);
    const endpoint = await this.#wait(taskArn, signal);
    await ready(this.#options.fetchImpl ?? fetch, endpoint, token, signal);
    return new EcsVerificationSandbox(taskArn, endpoint, token, this.#options.fetchImpl ?? fetch);
  }

  async restore(spec: VerificationSandboxSpec, sandboxRef: string, signal: AbortSignal): Promise<VerificationSandbox | undefined> {
    const result = await this.#client.send(new DescribeTasksCommand({ cluster: this.#options.cluster, tasks: [sandboxRef] }), { abortSignal: signal });
    const task = result.tasks?.[0]; if (task?.lastStatus !== "RUNNING") return undefined;
    const endpoint = endpointFor(task, this.#options.port ?? 8081);
    const token = authToken(this.#options.runnerSharedSecret, spec);
    await ready(this.#options.fetchImpl ?? fetch, endpoint, token, signal);
    return new EcsVerificationSandbox(sandboxRef, endpoint, token, this.#options.fetchImpl ?? fetch);
  }

  async destroy(sandbox: VerificationSandbox): Promise<void> {
    await this.#client.send(new StopTaskCommand({ cluster: this.#options.cluster, task: sandbox.id, reason: "Reef deterministic verification finished" }));
  }

  async #wait(taskArn: string, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + (this.#options.launchTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (signal.aborted) throw signal.reason ?? new Error("verification provisioning aborted");
      const result = await this.#client.send(new DescribeTasksCommand({ cluster: this.#options.cluster, tasks: [taskArn] }), { abortSignal: signal });
      const task = result.tasks?.[0];
      if (task?.lastStatus === "RUNNING") return endpointFor(task, this.#options.port ?? 8081);
      if (task?.lastStatus === "STOPPED") throw new Error(`ECS verification sandbox stopped: ${task.stoppedReason ?? "unknown"}`);
      await delay(this.#options.pollMs ?? 1000, signal);
    }
    throw new Error("timed out waiting for ECS verification sandbox");
  }
}

async function request(fetchImpl: typeof fetch, url: string, token: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal });
  const value = await response.json() as { readonly error?: unknown };
  if (!response.ok) throw new Error(`ECS verification sandbox request failed: ${response.status} ${String(value.error ?? "")}`);
  return value;
}

async function ready(fetchImpl: typeof fetch, endpoint: string, token: string, signal: AbortSignal): Promise<void> {
  const response = await fetchImpl(`${endpoint}/readyz`, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!response.ok) throw new Error(`ECS verification sandbox readiness failed: ${response.status}`);
}

function endpointFor(task: Task, port: number): string {
  for (const attachment of task.attachments ?? []) {
    const address = attachment.details?.find((item) => item.name === "privateIPv4Address")?.value;
    if (address !== undefined && address !== "") return `http://${address}:${port}`;
  }
  const address = task.containers?.[0]?.networkInterfaces?.[0]?.privateIpv4Address;
  if (address === undefined) throw new Error("ECS verification sandbox has no private IPv4 address");
  return `http://${address}:${port}`;
}

function authToken(secret: string, spec: VerificationSandboxSpec): string {
  return createHmac("sha256", secret).update(`${spec.runRef}\0${spec.attempt}\0${spec.imageDigest}`).digest("base64url");
}

function parseMessage(body: string): VerificationQueueMessage {
  const value = JSON.parse(body) as Partial<VerificationQueueMessage>;
  for (const key of ["id", "organisationRef", "projectRef", "runRef", "availableAt"] as const) {
    if (typeof value[key] !== "string" || value[key] === "") throw new Error(`invalid verification SQS message: ${key}`);
  }
  if (!Number.isInteger(value.attempt) || (value.attempt ?? 0) < 1) throw new Error("invalid verification SQS attempt");
  return value as VerificationQueueMessage;
}

function parseSecretRef(ref: string): { id: string; field?: string } {
  const prefix = "aws-secretsmanager://"; if (!ref.startsWith(prefix)) throw new Error("unsupported verification profile secretRef");
  const value = ref.slice(prefix.length); const index = value.indexOf("#");
  const id = decodeURIComponent(index < 0 ? value : value.slice(0, index));
  const field = index < 0 ? undefined : decodeURIComponent(value.slice(index + 1));
  if (id === "" || field === "") throw new Error("invalid verification profile secretRef");
  return { id, ...(field === undefined ? {} : { field }) };
}

function jsonField(secret: string, field: string): string {
  const value: unknown = JSON.parse(secret); if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("verification profile secret JSON is invalid");
  const selected = (value as Record<string, unknown>)[field]; if (typeof selected !== "string") throw new Error("verification profile secret field is not a string"); return selected;
}

function awsNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && ["NoSuchKey", "NotFound"].includes(String((error as { name?: unknown }).name));
}
function tenantKey(tenant: VerificationTenant): string { return `${tenant.organisationRef}\0${tenant.projectRef}`; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sha256(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function seconds(ms: number): number { return Math.max(0, Math.min(43_200, Math.ceil(ms / 1000))); }
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay) => { const timer = setTimeout(resolveDelay, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolveDelay(); }, { once: true }); });
}
