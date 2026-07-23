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
  BuilderSourceBundleBindingV1,
  BuilderSourceBundleDescriptorV1,
  ExternalMaterializationRequestV1,
  RuntimeMaterializationDescriptorV2,
  VerificationMaterialization,
  VerificationRun,
  VerificationSandbox,
} from "./types.js";
import {
  assertDigest,
  assertRelativePath,
  computeBuilderSourceBundleDigest,
  parseBuilderSourceBundleDescriptor,
  strictObject,
} from "./validation.js";
import {
  parseVerificationRunIdentity,
  verificationRunIdentity,
} from "./identity.js";

export type {
  ExternalMaterializationPort,
  ResolvedExternalMaterialization,
  SourceBundleMaterializer,
  SourceBundleStore,
} from "./ports.js";
export type {
  BuilderSourceBundleBindingV1,
  BuilderSourceBundleDescriptorV1,
  ExternalMaterializationRequestV1,
  RuntimeMaterializationDescriptorV2,
  VerificationMaterialization,
} from "./types.js";
export {
  computeBuilderSourceBundleDigest,
  parseBuilderSourceBundleDescriptor,
} from "./validation.js";

export const BUILDER_SOURCE_BUNDLE_SCHEMA_VERSION =
  "octopus.builder.source-bundle/v1" as const;
export const EXTERNAL_MATERIALIZATION_REQUEST_SCHEMA_VERSION =
  "octopus.reef.external-materialization-request/v1" as const;
export const RUNTIME_MATERIALIZATION_DESCRIPTOR_SCHEMA_VERSION =
  "octopus.reef.materialization-descriptor/v2" as const;
export const BUILDER_SOURCE_BUNDLE_BINDING_SCHEMA_VERSION =
  "octopus.reef.builder-source-bundle-binding/v1" as const;
export const MATERIALIZATION_SCHEMA_VERSION =
  "octopus.reef.materialization/v2" as const;
export const MATERIALIZATION_CONTRACT_VERSION = "2.0.0" as const;

export interface MaterializationLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathBytes: number;
}

export const DEFAULT_MATERIALIZATION_LIMITS: Readonly<MaterializationLimits> =
  Object.freeze({
    maxFiles: 10_000,
    maxFileBytes: 16 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
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
    const descriptor = await this.store.descriptor(
      tenant,
      request.sourceBundleRef,
    );
    return {
      descriptor,
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
    const builderDescriptor = parseBuilderSourceBundleDescriptor(
      resolved.descriptor,
    );
    const { inventory, totalBytes } = validateBuilderDescriptor(
      builderDescriptor,
      run,
      this.#limits,
    );
    const descriptor = runtimeMaterializationDescriptor(
      run,
      inventory,
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
    for (const entry of inventory) {
      abort(signal);
      const content = await resolved.read(entry.path, signal);
      if (content.byteLength !== entry.sizeBytes) {
        throw new Error("source materialization size mismatch");
      }
      const actual = sha256(content);
      if (actual !== entry.contentDigest) {
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
  descriptor: Omit<RuntimeMaterializationDescriptorV2, "descriptorDigest">,
): string {
  return `sha256:${canonicalHash(descriptor as never)}`;
}

export function computeBuilderSourceBundleBindingDigest(
  binding: Omit<BuilderSourceBundleBindingV1, "bindingRef" | "bindingDigest">,
): string {
  return `sha256:${canonicalHash(binding as never)}`;
}

export function builderSourceBundleBinding(
  run: VerificationRun,
): BuilderSourceBundleBindingV1 {
  const unsigned = {
    schemaVersion: BUILDER_SOURCE_BUNDLE_BINDING_SCHEMA_VERSION,
    organisationRef: run.organisationRef,
    projectRef: run.projectRef,
    candidateRef: run.candidateRef,
    candidateDigest: run.candidateDigest,
    sourceBundleRef: run.sourceBundleRef,
    sourceBundleDigest: run.sourceBundleDigest,
    pathPolicy: {
      unicodeNormalization: "NFC" as const,
      pathSemantics: "portable-nfc-casefold-v1" as const,
    },
  } satisfies Omit<
    BuilderSourceBundleBindingV1,
    "bindingRef" | "bindingDigest"
  >;
  const bindingDigest = computeBuilderSourceBundleBindingDigest(unsigned);
  return {
    ...unsigned,
    bindingRef: `builder-source-bundle-binding:${bindingDigest.slice("sha256:".length)}`,
    bindingDigest,
  };
}

export function runtimeMaterializationDescriptor(
  run: VerificationRun,
  inventory: BuilderSourceBundleDescriptorV1["inventory"],
  limits: Readonly<MaterializationLimits> = DEFAULT_MATERIALIZATION_LIMITS,
): RuntimeMaterializationDescriptorV2 {
  const binding = builderSourceBundleBinding(run);
  const unsigned = {
    schemaVersion: RUNTIME_MATERIALIZATION_DESCRIPTOR_SCHEMA_VERSION,
    contractVersion: MATERIALIZATION_CONTRACT_VERSION,
    identity: verificationRunIdentity(run),
    attempt: run.attempt,
    authoritativeBuilderSourceBundle: {
      schemaVersion: BUILDER_SOURCE_BUNDLE_SCHEMA_VERSION,
      bundleRef: run.sourceBundleRef,
      digest: run.sourceBundleDigest,
    },
    reefBinding: {
      schemaVersion: BUILDER_SOURCE_BUNDLE_BINDING_SCHEMA_VERSION,
      ref: binding.bindingRef,
      digest: binding.bindingDigest,
    },
    policy: {
      unicodeNormalization: "NFC" as const,
      pathSemantics: "portable-nfc-casefold-v1" as const,
      ...limits,
    },
    inventory,
  } satisfies Omit<RuntimeMaterializationDescriptorV2, "descriptorDigest">;
  return {
    ...unsigned,
    descriptorDigest: computeRuntimeMaterializationDescriptorDigest(unsigned),
  };
}

function validateBuilderDescriptor(
  descriptor: BuilderSourceBundleDescriptorV1,
  run: VerificationRun,
  limits: Readonly<MaterializationLimits>,
): {
  readonly inventory: BuilderSourceBundleDescriptorV1["inventory"];
  readonly totalBytes: number;
} {
  if (
    descriptor.schemaVersion !== BUILDER_SOURCE_BUNDLE_SCHEMA_VERSION ||
    descriptor.organisationRef !== run.organisationRef ||
    descriptor.projectRef !== run.projectRef ||
    descriptor.bundleRef !== run.sourceBundleRef ||
    descriptor.digest !== run.sourceBundleDigest
  ) {
    throw new Error("Builder source bundle descriptor identity mismatch");
  }
  if (
    descriptor.inventory.length < 1 ||
    descriptor.inventory.length > limits.maxFiles
  ) {
    throw new Error("source bundle file count is outside limits");
  }
  const authoritativeDigest = computeBuilderSourceBundleDigest(
    descriptor.inventory,
  );
  if (
    authoritativeDigest !== descriptor.digest ||
    authoritativeDigest !== run.sourceBundleDigest
  ) {
    throw new Error("authoritative Builder source bundle digest mismatch");
  }

  const seen = new Set<string>();
  let previousPath: string | undefined;
  let totalBytes = 0;
  const inventory = descriptor.inventory.map((entry) => {
    const path = assertRelativePath(entry.path, "source bundle path");
    if (previousPath !== undefined && previousPath >= path) {
      throw new Error(
        "source bundle entries are not uniquely ECMAScript-string-sorted",
      );
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
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      entry.sizeBytes > limits.maxFileBytes
    ) {
      throw new Error("source file exceeds size limit");
    }
    assertDigest(entry.contentDigest, "source entry digest");
    totalBytes += entry.sizeBytes;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > limits.maxTotalBytes
    ) {
      throw new Error("source bundle exceeds total byte limit");
    }
    return {
      path,
      contentDigest: entry.contentDigest,
      sizeBytes: entry.sizeBytes,
    };
  });
  return { inventory, totalBytes };
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
  descriptor: RuntimeMaterializationDescriptorV2,
  totalBytes: number,
): VerificationMaterialization {
  const digest = descriptor.descriptorDigest;
  assertDigest(digest, "runtime materialization descriptor digest");
  return {
    schemaVersion: MATERIALIZATION_SCHEMA_VERSION,
    ref: `materialization:${digest.slice("sha256:".length)}`,
    runtimeDescriptorRef: `materialization-descriptor:${digest.slice("sha256:".length)}`,
    runtimeDescriptorDigest: digest,
    builderSourceBundleRef:
      descriptor.authoritativeBuilderSourceBundle.bundleRef,
    builderSourceBundleDigest:
      descriptor.authoritativeBuilderSourceBundle.digest,
    builderSourceBundleBindingRef: descriptor.reefBinding.ref,
    builderSourceBundleBindingDigest: descriptor.reefBinding.digest,
    entryCount: descriptor.inventory.length,
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
