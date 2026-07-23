import { createHash } from "node:crypto";
import { canonicalHash } from "octopus-evidence";
import type {
  BuilderSourceBundleDescriptorV1,
  BuilderSourceBundleFileV1,
  SourceBundleDescriptor,
  TrustedVerificationProfile,
  VerificationRunRequest,
  VerificationTenant,
} from "./types.js";
import { InvalidVerificationRequestError } from "./errors.js";

const REQUEST_KEYS = new Set([
  "organisationRef",
  "projectRef",
  "candidateRef",
  "candidateDigest",
  "sourceBundleRef",
  "sourceBundleDigest",
  "verificationProfileRef",
  "verificationProfileVersion",
  "verificationProfileDigest",
  "idempotencyKey",
]);

const FORBIDDEN_KEYS = new Set([
  "task",
  "command",
  "argv",
  "cwd",
  "env",
  "environment",
  "secretRefs",
  "credentials",
  "apiKey",
  "token",
  "url",
  "uri",
  "s3Uri",
  "bucket",
  "key",
  "workingDirectory",
  "secretRef",
]);

const SOURCE_BUNDLE_DESCRIPTOR_KEYS = new Set([
  "schemaVersion",
  "organisationRef",
  "projectRef",
  "bundleRef",
  "digest",
  "inventory",
]);

const SOURCE_BUNDLE_ENTRY_KEYS = new Set([
  "path",
  "contentDigest",
  "sizeBytes",
]);

export function parseVerificationRunRequest(
  value: unknown,
): VerificationRunRequest {
  try {
    return parseVerificationRunRequestValue(value);
  } catch (error) {
    if (error instanceof InvalidVerificationRequestError) throw error;
    throw new InvalidVerificationRequestError(
      error instanceof Error ? error.message : "invalid verification request",
      { cause: error },
    );
  }
}

function parseVerificationRunRequestValue(
  value: unknown,
): VerificationRunRequest {
  const record = strictObject(value, "verification request");
  for (const key of Object.keys(record)) {
    if (!REQUEST_KEYS.has(key)) {
      const description = FORBIDDEN_KEYS.has(key) ? "forbidden" : "unknown";
      throw new Error(`${description} verification request field: ${key}`);
    }
  }
  if (Object.keys(record).length !== REQUEST_KEYS.size) {
    throw new Error(
      "verification request must contain the exact v1 identity fields",
    );
  }
  const request = {
    organisationRef: nonempty(record, "organisationRef"),
    projectRef: nonempty(record, "projectRef"),
    candidateRef: nonempty(record, "candidateRef"),
    candidateDigest: digest(record, "candidateDigest"),
    sourceBundleRef: nonempty(record, "sourceBundleRef"),
    sourceBundleDigest: digest(record, "sourceBundleDigest"),
    verificationProfileRef: nonempty(record, "verificationProfileRef"),
    verificationProfileVersion: immutableVersion(
      nonempty(record, "verificationProfileVersion"),
    ),
    verificationProfileDigest: digest(record, "verificationProfileDigest"),
    idempotencyKey: bounded(nonempty(record, "idempotencyKey"), 256),
  } satisfies VerificationRunRequest;
  for (const [name, ref] of Object.entries({
    organisationRef: request.organisationRef,
    projectRef: request.projectRef,
    candidateRef: request.candidateRef,
    sourceBundleRef: request.sourceBundleRef,
    verificationProfileRef: request.verificationProfileRef,
  })) {
    if (
      Buffer.byteLength(ref, "utf8") > 1024 ||
      ref.startsWith("/") ||
      ref.includes("://") ||
      ref.includes("\\") ||
      ref !== ref.trim() ||
      /\p{Cc}/u.test(ref)
    ) {
      throw new Error(`${name} must be a bounded opaque reference`);
    }
  }
  return request;
}

export function assertTenantBinding(
  tenant: VerificationTenant,
  request: VerificationRunRequest,
): void {
  if (
    request.organisationRef !== tenant.organisationRef ||
    request.projectRef !== tenant.projectRef
  ) {
    throw new InvalidVerificationRequestError(
      "verification request identity does not match tenant headers",
    );
  }
}

/** Strict runtime parser for untrusted descriptor JSON returned by a bundle store. */
export function parseSourceBundleDescriptor(
  value: unknown,
): SourceBundleDescriptor {
  return parseBuilderSourceBundleDescriptor(value);
}

/** Strict parser for the Builder-owned octopus.builder.source-bundle/v1. */
export function parseBuilderSourceBundleDescriptor(
  value: unknown,
): BuilderSourceBundleDescriptorV1 {
  try {
    const descriptor = strictObject(value, "source bundle descriptor");
    exactKeys(
      descriptor,
      SOURCE_BUNDLE_DESCRIPTOR_KEYS,
      "source bundle descriptor",
    );
    if (descriptor["schemaVersion"] !== "octopus.builder.source-bundle/v1") {
      throw new Error("unsupported source bundle schemaVersion");
    }
    const organisationRef = builderScopeReference(
      descriptor,
      "organisationRef",
    );
    const projectRef = builderScopeReference(descriptor, "projectRef");
    const bundleRef = nonempty(descriptor, "bundleRef");
    const descriptorDigest = digest(descriptor, "digest");
    if (
      !/^source-bundle:sha256:[0-9a-f]{64}$/.test(bundleRef) ||
      bundleRef !== `source-bundle:${descriptorDigest}`
    ) {
      throw new Error("Builder source bundle ref/digest mismatch");
    }
    const rawEntries = descriptor["inventory"];
    if (!Array.isArray(rawEntries))
      throw new Error("source bundle inventory must be an array");
    const inventory = rawEntries.map((rawEntry, index) => {
      const entry = strictObject(rawEntry, `source bundle inventory ${index}`);
      exactKeys(
        entry,
        SOURCE_BUNDLE_ENTRY_KEYS,
        `source bundle inventory ${index}`,
      );
      const path = assertBuilderSourceBundlePath(
        nonempty(entry, "path"),
        "source bundle path",
      );
      const sizeBytes = entry["sizeBytes"];
      if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0) {
        throw new Error(`source bundle inventory ${index} size is invalid`);
      }
      const contentDigest = digest(entry, "contentDigest");
      return {
        path,
        contentDigest,
        sizeBytes: Number(sizeBytes),
      };
    });
    if (inventory.length === 0) {
      throw new Error("source bundle inventory must not be empty");
    }
    for (let index = 1; index < inventory.length; index += 1) {
      if (inventory[index - 1]!.path >= inventory[index]!.path) {
        throw new Error("source bundle inventory is not canonically sorted");
      }
    }
    const calculatedDigest = computeBuilderSourceBundleDigest(inventory);
    if (calculatedDigest !== descriptorDigest) {
      throw new Error("Builder source bundle authoritative digest mismatch");
    }
    return {
      schemaVersion: "octopus.builder.source-bundle/v1",
      organisationRef,
      projectRef,
      bundleRef,
      digest: descriptorDigest,
      inventory,
    };
  } catch (error) {
    if (error instanceof InvalidVerificationRequestError) throw error;
    throw new InvalidVerificationRequestError(
      error instanceof Error
        ? error.message
        : "invalid source bundle descriptor",
      { cause: error },
    );
  }
}

/** @deprecated Use parseBuilderSourceBundleDescriptor. */
export const parseBuilderSourceBundleInventory =
  parseBuilderSourceBundleDescriptor;

export function profileCanonicalInput(
  profile: Omit<TrustedVerificationProfile, "digest">,
): unknown {
  return {
    ref: profile.ref,
    version: profile.version,
    sandboxImageDigest: profile.sandboxImageDigest,
    maxDurationMs: profile.maxDurationMs,
    maxChecks: profile.maxChecks,
    checks: profile.checks,
  };
}

export function computeProfileDigest(
  profile: Omit<TrustedVerificationProfile, "digest">,
): string {
  return `sha256:${canonicalHash(profileCanonicalInput(profile) as never)}`;
}

export function computeBundleDigest(
  descriptor: Omit<SourceBundleDescriptor, "digest" | "bundleRef">,
): string {
  return computeBuilderSourceBundleDigest(descriptor.inventory);
}

export function computeBuilderSourceBundleDigest(
  inventory: readonly BuilderSourceBundleFileV1[],
): string {
  const files = inventory
    .map((file) => ({
      path: assertBuilderSourceBundlePath(
        file.path,
        "Builder source bundle path",
      ),
      contentDigest: checkedDigest(
        file.contentDigest,
        "Builder source bundle contentDigest",
      ),
      sizeBytes: checkedSize(file.sizeBytes),
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path === files[index]!.path) {
      throw new Error("Builder source bundle contains duplicate paths");
    }
  }
  const bytes = JSON.stringify({
    schemaVersion: "octopus.builder.source-bundle/v1",
    files: files.map((file) => ({
      path: file.path,
      contentDigest: file.contentDigest,
      sizeBytes: file.sizeBytes,
    })),
  });
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function checkedDigest(value: string, name: string): string {
  assertDigest(value, name);
  return value;
}

function checkedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "Builder source bundle sizeBytes must be a non-negative safe integer",
    );
  }
  return value;
}

export function assertDigest(value: string, name = "digest"): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase sha256 digest`);
  }
}

export function assertRelativePath(value: string, name = "path"): string {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    segments.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        part.includes(":"),
    ) ||
    value.normalize("NFC") !== value ||
    /\p{Cc}/u.test(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`${name} is not a canonical NFC relative path`);
  }
  return value;
}

/**
 * Builder v1's exact published path validator. Reef's stricter portable path
 * policy is applied separately by the materializer and recorded in the Reef
 * source-bundle binding.
 */
export function assertBuilderSourceBundlePath(
  value: string,
  name = "Builder source bundle path",
): string {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.normalize("NFC") !== value ||
    /\p{Cc}/u.test(value) ||
    segments.some((part) => part === "" || part === "." || part === "..") ||
    /^[A-Za-z]:$/.test(segments[0] ?? "")
  ) {
    throw new Error(`${name} is not a Builder v1 canonical relative path`);
  }
  return value;
}

export function assertWorkingDirectory(value: string): string {
  if (value === ".") return value;
  return assertRelativePath(value, "check working directory");
}

export function strictObject(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonempty(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function digest(record: Record<string, unknown>, key: string): string {
  const value = nonempty(record, key);
  assertDigest(value, key);
  return value;
}

function bounded(value: string, maximum: number): string {
  if (value.length > maximum)
    throw new Error(`value exceeds ${maximum} characters`);
  return value;
}

function immutableVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(
      "verificationProfileVersion must be an immutable semantic version",
    );
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
  name: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`${name} contains missing or unsupported fields`);
  }
}

function builderScopeReference(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = nonempty(record, key);
  if (
    Buffer.byteLength(value, "utf8") > 512 ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${key} must be a canonical Builder v1 scope reference`);
  }
  return value;
}
