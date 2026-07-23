import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalHash } from "octopus-evidence";
import type {
  ExternalMaterializationPort,
  ResolvedExternalMaterialization,
  SourceBundleMaterializer,
  SourceBundleStore,
} from "./ports.js";
import type {
  BuilderSourceBundleInventoryV1,
  ExternalMaterializationRequestV1,
  RuntimeMaterializationDescriptorV1,
  VerificationMaterialization,
  VerificationRun,
  VerificationSandbox,
} from "./types.js";
import {
  assertDigest,
  assertRelativePath,
  computeBuilderSourceBundleDigest,
  parseBuilderSourceBundleInventory,
  strictObject,
} from "./validation.js";
import {
  assertVerificationRunIdentity,
  parseVerificationRunIdentity,
  verificationRunIdentity,
} from "./identity.js";

export const BUILDER_SOURCE_BUNDLE_SCHEMA_VERSION =
  "octopus.builder.source-bundle/v1" as const;
export const EXTERNAL_MATERIALIZATION_REQUEST_SCHEMA_VERSION =
  "octopus.reef.external-materialization-request/v1" as const;
export const RUNTIME_MATERIALIZATION_DESCRIPTOR_SCHEMA_VERSION =
  "octopus.reef.materialization-descriptor/v1" as const;
export const MATERIALIZATION_SCHEMA_VERSION =
  "octopus.reef.materialization/v1" as const;
export const MATERIALIZATION_CONTRACT_VERSION = "1.0.0" as const;

export interface MaterializationLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathBytes: number;
}

export const DEFAULT_MATERIALIZATION_LIMITS: Readonly<MaterializationLimits> =
  Object.freeze({
    maxFiles: 20_000,
    maxFileBytes: 16 * 1024 * 1024,
    maxTotalBytes: 512 * 1024 * 1024,
    maxPathBytes: 1024,
  });

export interface DeterministicSourceBundleMaterializerOptions {
  readonly port?: ExternalMaterializationPort;
  /** @deprecated Wraps the trusted store in SourceBundleStoreMaterializationBridge. */
  readonly store?: SourceBundleStore;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxPathBytes?: number;
}

/**
 * Server-side bridge for trusted local/ArtifactStore/S3 adapters.
 *
 * Storage locations and credentials remain constructor configuration. The
 * request and returned inventory contain no URL, bucket, key, command, or
 * secret selector.
 */
export class SourceBundleStoreMaterializationBridge implements ExternalMaterializationPort {
  constructor(private readonly store: SourceBundleStore) {}

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
    const inventory = await this.store.descriptor(
      tenant,
      request.sourceBundleRef,
    );
    return {
      inventory,
      read: (path, readSignal) => {
        abort(readSignal);
        return this.store.content(tenant, request.sourceBundleRef, path);
      },
    };
  }
}

/**
 * Validates the Builder inventory and every regular file before committing any
 * bytes to the sandbox. A failed write removes all files written by this call.
 */
export class DeterministicSourceBundleMaterializer implements SourceBundleMaterializer {
  readonly #port: ExternalMaterializationPort;
  readonly #limits: Readonly<MaterializationLimits>;

  constructor(options: DeterministicSourceBundleMaterializerOptions) {
    if ((options.port === undefined) === (options.store === undefined)) {
      throw new Error(
        "materializer requires exactly one trusted port or store",
      );
    }
    this.#port =
      options.port ??
      new SourceBundleStoreMaterializationBridge(options.store!);
    this.#limits = Object.freeze({
      maxFiles: limit(
        options.maxFiles,
        DEFAULT_MATERIALIZATION_LIMITS.maxFiles,
      ),
      maxFileBytes: limit(
        options.maxFileBytes,
        DEFAULT_MATERIALIZATION_LIMITS.maxFileBytes,
      ),
      maxTotalBytes: limit(
        options.maxTotalBytes,
        DEFAULT_MATERIALIZATION_LIMITS.maxTotalBytes,
      ),
      maxPathBytes: limit(
        options.maxPathBytes,
        DEFAULT_MATERIALIZATION_LIMITS.maxPathBytes,
      ),
    });
  }

  async materialize(
    run: VerificationRun,
    sandbox: VerificationSandbox,
    signal: AbortSignal,
  ): Promise<VerificationMaterialization> {
    abort(signal);
    const request = externalMaterializationRequest(run);
    const resolved = await this.#port.resolve(request, signal);
    const inventory = parseBuilderSourceBundleInventory(resolved.inventory);
    const { entries, totalBytes } = validateInventory(
      inventory,
      run,
      this.#limits,
    );
    const descriptor = runtimeMaterializationDescriptor(
      run,
      entries,
      this.#limits,
    );
    const materialization = materializationIdentity(descriptor, totalBytes);
    if (
      run.materialization !== undefined &&
      !isDeepStrictEqual(run.materialization, materialization)
    ) {
      throw new Error(
        "runtime materialization descriptor replacement detected",
      );
    }

    const staged: {
      readonly path: string;
      readonly content: Uint8Array;
    }[] = [];
    for (const entry of entries) {
      abort(signal);
      const content = await resolved.read(entry.path, signal);
      if (content.byteLength !== entry.size) {
        throw new Error("source materialization size mismatch");
      }
      const actual = sha256(content);
      if (actual !== entry.digest) {
        throw new Error("source materialization digest mismatch");
      }
      staged.push({ path: entry.path, content });
    }

    const written: string[] = [];
    try {
      for (const file of staged) {
        abort(signal);
        const result = await sandbox.writeFile(file.path, file.content, signal);
        if (result.created) written.push(file.path);
      }
    } catch (error) {
      try {
        await sandbox.removeFiles(written, new AbortController().signal);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "partial source materialization cleanup failed",
        );
      }
      throw error;
    }
    return materialization;
  }
}

export function parseExternalMaterializationRequest(
  value: unknown,
): ExternalMaterializationRequestV1 {
  const request = strictObject(value, "external materialization request");
  const expected = new Set([
    "schemaVersion",
    "organisationRef",
    "projectRef",
    "candidateRef",
    "candidateDigest",
    "sourceBundleRef",
    "sourceBundleDigest",
    "verificationProfileRef",
    "verificationProfileVersion",
    "verificationProfileDigest",
    "runRef",
    "attempt",
  ]);
  const keys = Object.keys(request);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(
      "external materialization request contains missing or forbidden fields",
    );
  }
  if (
    request["schemaVersion"] !== EXTERNAL_MATERIALIZATION_REQUEST_SCHEMA_VERSION
  ) {
    throw new Error("unsupported external materialization request version");
  }
  const identity = parseVerificationRunIdentity(
    request,
    "external materialization request identity",
  );
  const attempt = request["attempt"];
  if (!Number.isSafeInteger(attempt) || Number(attempt) < 1) {
    throw new Error("external materialization request attempt is invalid");
  }
  return {
    schemaVersion: EXTERNAL_MATERIALIZATION_REQUEST_SCHEMA_VERSION,
    ...identity,
    attempt: Number(attempt),
  };
}

export function externalMaterializationRequest(
  run: VerificationRun,
): ExternalMaterializationRequestV1 {
  return parseExternalMaterializationRequest({
    schemaVersion: EXTERNAL_MATERIALIZATION_REQUEST_SCHEMA_VERSION,
    ...verificationRunIdentity(run),
    attempt: run.attempt,
  });
}

export function computeRuntimeMaterializationDescriptorDigest(
  descriptor: Omit<RuntimeMaterializationDescriptorV1, "descriptorDigest">,
): string {
  return `sha256:${canonicalHash(descriptor as never)}`;
}

export function runtimeMaterializationDescriptor(
  run: VerificationRun,
  entries: BuilderSourceBundleInventoryV1["entries"],
  limits: Readonly<MaterializationLimits> = DEFAULT_MATERIALIZATION_LIMITS,
): RuntimeMaterializationDescriptorV1 {
  const unsigned = {
    schemaVersion: RUNTIME_MATERIALIZATION_DESCRIPTOR_SCHEMA_VERSION,
    contractVersion: MATERIALIZATION_CONTRACT_VERSION,
    identity: verificationRunIdentity(run),
    attempt: run.attempt,
    authoritativeSourceBundle: {
      schemaVersion: BUILDER_SOURCE_BUNDLE_SCHEMA_VERSION,
      ref: run.sourceBundleRef,
      digest: run.sourceBundleDigest,
    },
    policy: {
      unicodeNormalization: "NFC" as const,
      pathSemantics: "portable-nfc-casefold-v1" as const,
      ...limits,
    },
    entries,
  } satisfies Omit<RuntimeMaterializationDescriptorV1, "descriptorDigest">;
  return {
    ...unsigned,
    descriptorDigest: computeRuntimeMaterializationDescriptorDigest(unsigned),
  };
}

function validateInventory(
  inventory: BuilderSourceBundleInventoryV1,
  run: VerificationRun,
  limits: Readonly<MaterializationLimits>,
): {
  readonly entries: BuilderSourceBundleInventoryV1["entries"];
  readonly totalBytes: number;
} {
  const inventoryIdentity = parseVerificationRunIdentity(
    {
      ...inventory,
      verificationProfileRef: run.verificationProfileRef,
      verificationProfileVersion: run.verificationProfileVersion,
      verificationProfileDigest: run.verificationProfileDigest,
      runRef: run.runRef,
    },
    "Builder source bundle identity",
  );
  assertVerificationRunIdentity(
    inventoryIdentity,
    verificationRunIdentity(run),
    "Builder source bundle identity",
  );
  if (
    inventory.schemaVersion !== BUILDER_SOURCE_BUNDLE_SCHEMA_VERSION ||
    inventory.unicodeNormalization !== "NFC" ||
    inventory.pathSemantics !== "portable-nfc-casefold-v1"
  ) {
    throw new Error("unsupported Builder source bundle inventory");
  }
  if (
    inventory.entries.length < 1 ||
    inventory.entries.length > limits.maxFiles
  ) {
    throw new Error("source bundle file count is outside limits");
  }
  const authoritativeDigest = computeBuilderSourceBundleDigest({
    schemaVersion: inventory.schemaVersion,
    organisationRef: inventory.organisationRef,
    projectRef: inventory.projectRef,
    candidateRef: inventory.candidateRef,
    candidateDigest: inventory.candidateDigest,
    sourceBundleRef: inventory.sourceBundleRef,
    unicodeNormalization: inventory.unicodeNormalization,
    pathSemantics: inventory.pathSemantics,
    entries: inventory.entries,
  });
  if (
    authoritativeDigest !== inventory.sourceBundleDigest ||
    authoritativeDigest !== run.sourceBundleDigest
  ) {
    throw new Error("authoritative Builder source bundle digest mismatch");
  }

  const seen = new Set<string>();
  let previousPath: string | undefined;
  let totalBytes = 0;
  const entries = inventory.entries.map((entry) => {
    if (entry.kind !== "file") {
      throw new Error("source bundle entry is not a regular file");
    }
    const path = assertRelativePath(entry.path, "source bundle path");
    if (
      previousPath !== undefined &&
      Buffer.compare(
        Buffer.from(previousPath, "utf8"),
        Buffer.from(path, "utf8"),
      ) >= 0
    ) {
      throw new Error("source bundle entries are not uniquely byte-sorted");
    }
    previousPath = path;
    const collisionKey = portableCaseFold(path);
    if (seen.has(collisionKey)) {
      throw new Error("duplicate or case-ambiguous source path");
    }
    seen.add(collisionKey);
    if (Buffer.byteLength(path, "utf8") > limits.maxPathBytes) {
      throw new Error("source path exceeds byte limit");
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > limits.maxFileBytes
    ) {
      throw new Error("source file exceeds size limit");
    }
    assertDigest(entry.digest, "source entry digest");
    totalBytes += entry.size;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > limits.maxTotalBytes
    ) {
      throw new Error("source bundle exceeds total byte limit");
    }
    return {
      kind: "file" as const,
      path,
      size: entry.size,
      digest: entry.digest,
    };
  });
  return { entries, totalBytes };
}

/**
 * portable-nfc-casefold-v1 is the exact locale-independent ECMAScript
 * full-fold approximation NFC(lower(upper(NFC(path)))). The upper/lower pair
 * expands multi-code-point folds such as ß/ss and normalizes final sigma.
 */
export function portableCaseFold(path: string): string {
  return path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

function materializationIdentity(
  descriptor: RuntimeMaterializationDescriptorV1,
  totalBytes: number,
): VerificationMaterialization {
  const digest = descriptor.descriptorDigest;
  assertDigest(digest, "runtime materialization descriptor digest");
  return {
    schemaVersion: MATERIALIZATION_SCHEMA_VERSION,
    ref: `materialization:${digest.slice("sha256:".length)}`,
    runtimeDescriptorDigest: digest,
    authoritativeSourceBundleDigest:
      descriptor.authoritativeSourceBundle.digest,
    entryCount: descriptor.entries.length,
    totalBytes,
  };
}

function limit(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error("materialization limit must be a positive safe integer");
  }
  return selected;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("verification aborted");
}
