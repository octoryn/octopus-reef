import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import type {
  ExternalMaterializationPort,
  ResolvedExternalMaterialization,
} from "../ports.js";
import type {
  ExternalMaterializationRequestV1,
  VerificationTenant,
} from "../types.js";
import {
  parseBuilderSourceBundleDescriptor,
  strictObject,
} from "../validation.js";
import { parseExternalMaterializationRequest } from "../materializer.js";

const DEFAULT_PREFIX = "manufacturing/source-bundles";
const DEFAULT_MAX_DESCRIPTOR_BYTES = 8 * 1024 * 1024;

export interface BuilderSourceBundleS3Client {
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
}

export interface TrustedBuilderSourceBundleS3Location {
  readonly bucket: string;
  readonly prefix?: string;
  readonly expectedBucketOwner: string;
}

/**
 * Deployment-owned resolver. It is never selected by external request fields.
 */
export interface TrustedBuilderSourceBundleS3Resolver {
  resolve(
    tenant: VerificationTenant,
  ):
    | TrustedBuilderSourceBundleS3Location
    | Promise<TrustedBuilderSourceBundleS3Location>;
}

export interface AwsS3BuilderSourceBundleMaterializationPortOptions {
  readonly resolver: TrustedBuilderSourceBundleS3Resolver;
  readonly client?: BuilderSourceBundleS3Client;
  readonly maxDescriptorBytes?: number;
}

/**
 * Read-only adapter for Builder's published v1 descriptor/key/blob layout.
 * Bucket, prefix and owner are trusted deployment configuration.
 */
export class AwsS3BuilderSourceBundleMaterializationPort implements ExternalMaterializationPort {
  readonly #resolver: TrustedBuilderSourceBundleS3Resolver;
  readonly #client: BuilderSourceBundleS3Client;
  readonly #maxDescriptorBytes: number;

  constructor(options: AwsS3BuilderSourceBundleMaterializationPortOptions) {
    this.#resolver = options.resolver;
    this.#client = options.client ?? new S3Client({});
    this.#maxDescriptorBytes = positiveLimit(
      options.maxDescriptorBytes,
      DEFAULT_MAX_DESCRIPTOR_BYTES,
    );
  }

  async resolve(
    rawRequest: ExternalMaterializationRequestV1,
    signal: AbortSignal,
  ): Promise<ResolvedExternalMaterialization> {
    abort(signal);
    const request = parseExternalMaterializationRequest(rawRequest);
    const tenant = {
      organisationRef: request.organisationRef,
      projectRef: request.projectRef,
    };
    const location = parseTrustedLocation(await this.#resolver.resolve(tenant));
    const layout = builderSourceBundleS3ObjectLayout(
      location,
      tenant,
      request.sourceBundleRef,
    );
    const rawDescriptor = await this.#read(
      location,
      layout.descriptorKey,
      this.#maxDescriptorBytes,
      signal,
    );
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(rawDescriptor),
      );
    } catch (error) {
      throw new Error("Builder source bundle descriptor is not UTF-8 JSON", {
        cause: error,
      });
    }
    const descriptor = parseBuilderSourceBundleDescriptor(parsedJson);
    if (
      descriptor.organisationRef !== request.organisationRef ||
      descriptor.projectRef !== request.projectRef ||
      descriptor.bundleRef !== request.sourceBundleRef ||
      descriptor.digest !== request.sourceBundleDigest
    ) {
      throw new Error("Builder source bundle descriptor replacement detected");
    }
    const entries = new Map(
      descriptor.inventory.map((entry) => [entry.path, entry] as const),
    );
    return {
      descriptor,
      read: async (path, readSignal) => {
        abort(readSignal);
        const entry = entries.get(path);
        if (entry === undefined) {
          throw new Error("Builder source bundle path is not in inventory");
        }
        const bytes = await this.#read(
          location,
          layout.blobKey(entry.contentDigest),
          entry.sizeBytes + 1,
          readSignal,
        );
        if (
          bytes.byteLength !== entry.sizeBytes ||
          sha256(bytes) !== entry.contentDigest
        ) {
          throw new Error("Builder source bundle blob integrity mismatch");
        }
        return bytes;
      },
    };
  }

  async #read(
    location: ResolvedLocation,
    key: string,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    abort(signal);
    const response = await this.#client.send(
      new GetObjectCommand({
        Bucket: location.bucket,
        Key: key,
        ExpectedBucketOwner: location.expectedBucketOwner,
        ChecksumMode: "ENABLED",
      }),
    );
    if (response.Body === undefined) {
      throw new Error("Builder source bundle object body is missing");
    }
    if (
      response.ContentLength !== undefined &&
      (!Number.isSafeInteger(response.ContentLength) ||
        response.ContentLength < 0 ||
        response.ContentLength > maximumBytes)
    ) {
      throw new Error("Builder source bundle object exceeds byte limit");
    }
    return boundedBody(response.Body, maximumBytes, signal);
  }
}

interface ResolvedLocation {
  readonly bucket: string;
  readonly prefix: string;
  readonly expectedBucketOwner: string;
}

export interface BuilderSourceBundleS3ObjectLayout {
  readonly descriptorKey: string;
  blobKey(contentDigest: string): string;
}

/**
 * Byte-exact Builder v1 object layout. This accepts only trusted deployment
 * configuration plus already validated opaque scope/bundle identities.
 */
export function builderSourceBundleS3ObjectLayout(
  rawLocation: TrustedBuilderSourceBundleS3Location,
  tenant: VerificationTenant,
  bundleRef: string,
): BuilderSourceBundleS3ObjectLayout {
  const location = parseTrustedLocation(rawLocation);
  const digestMatch = /^source-bundle:sha256:([0-9a-f]{64})$/.exec(bundleRef);
  if (digestMatch === null) {
    throw new Error("Builder source bundle ref is not canonical");
  }
  const organisationHash = hash(
    JSON.stringify([
      "octopus.builder.source-bundle.organisation/v1",
      tenant.organisationRef,
    ]),
  );
  const projectHash = hash(
    JSON.stringify([
      "octopus.builder.source-bundle.project/v1",
      tenant.organisationRef,
      tenant.projectRef,
    ]),
  );
  const bundlePrefix =
    `${location.prefix}/v1/org=${organisationHash}` +
    `/project=${projectHash}/bundles/${digestMatch[1]}`;
  return Object.freeze({
    descriptorKey: `${bundlePrefix}/descriptor.json`,
    blobKey: (contentDigest: string): string => {
      const match = /^sha256:([0-9a-f]{64})$/.exec(contentDigest);
      if (match === null) {
        throw new Error(
          "Builder source bundle content digest is not canonical",
        );
      }
      return `${bundlePrefix}/blobs/${match[1]}`;
    },
  });
}

function parseTrustedLocation(
  value: TrustedBuilderSourceBundleS3Location,
): ResolvedLocation {
  const location = strictObject(value, "trusted Builder S3 location");
  const allowed = new Set(["bucket", "prefix", "expectedBucketOwner"]);
  if (Object.keys(location).some((key) => !allowed.has(key))) {
    throw new Error("trusted Builder S3 location contains unsupported fields");
  }
  const bucket = canonicalSetting(location["bucket"], "bucket");
  const expectedBucketOwner = canonicalSetting(
    location["expectedBucketOwner"],
    "expectedBucketOwner",
  );
  if (!/^[0-9]{12}$/.test(expectedBucketOwner)) {
    throw new Error("trusted Builder S3 owner is invalid");
  }
  const prefix = canonicalSetting(
    location["prefix"] ?? DEFAULT_PREFIX,
    "prefix",
  );
  if (
    prefix.startsWith("/") ||
    prefix.endsWith("/") ||
    prefix.includes("\\") ||
    prefix
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("trusted Builder S3 prefix is invalid");
  }
  return { bucket, prefix, expectedBucketOwner };
}

function canonicalSetting(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`trusted Builder S3 ${name} is invalid`);
  }
  return value;
}

async function boundedBody(
  body: unknown,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (
    body !== null &&
    typeof body === "object" &&
    Symbol.asyncIterator in body
  ) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const rawChunk of body as AsyncIterable<unknown>) {
      abort(signal);
      const chunk =
        rawChunk instanceof Uint8Array
          ? rawChunk
          : Buffer.from(rawChunk as string);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        throw new Error("Builder source bundle object exceeds byte limit");
      }
      chunks.push(Uint8Array.from(chunk));
    }
    return Uint8Array.from(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    );
  }
  if (
    body !== null &&
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > maximumBytes) {
      throw new Error("Builder source bundle object exceeds byte limit");
    }
    return Uint8Array.from(bytes);
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maximumBytes) {
      throw new Error("Builder source bundle object exceeds byte limit");
    }
    return Uint8Array.from(body);
  }
  throw new Error("Builder source bundle object body is unreadable");
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error("Builder source bundle byte limit is invalid");
  }
  return selected;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("verification aborted");
}
