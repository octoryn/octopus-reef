import { createHash } from "node:crypto";
import type {
  SourceBundleMaterializer,
  SourceBundleStore,
} from "./ports.js";
import type {
  SourceBundleDescriptor,
  VerificationRun,
  VerificationSandbox,
} from "./types.js";
import {
  assertDigest,
  assertRelativePath,
  computeBundleDigest,
} from "./validation.js";

export interface DeterministicSourceBundleMaterializerOptions {
  readonly store: SourceBundleStore;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxPathBytes?: number;
}

/** Validates a descriptor and every regular file before writing a fresh sandbox. */
export class DeterministicSourceBundleMaterializer
  implements SourceBundleMaterializer
{
  readonly #options: Required<Omit<DeterministicSourceBundleMaterializerOptions, "store">> & {
    readonly store: SourceBundleStore;
  };

  constructor(options: DeterministicSourceBundleMaterializerOptions) {
    this.#options = {
      store: options.store,
      maxFiles: options.maxFiles ?? 20_000,
      maxFileBytes: options.maxFileBytes ?? 16 * 1024 * 1024,
      maxTotalBytes: options.maxTotalBytes ?? 512 * 1024 * 1024,
      maxPathBytes: options.maxPathBytes ?? 1024,
    };
  }

  async materialize(
    run: VerificationRun,
    sandbox: VerificationSandbox,
    signal: AbortSignal,
  ): Promise<void> {
    abort(signal);
    const tenant = {
      organisationRef: run.organisationRef,
      projectRef: run.projectRef,
    };
    const descriptor = await this.#options.store.descriptor(
      tenant,
      run.sourceBundleRef,
    );
    validateDescriptor(descriptor, run, this.#options);
    const seen = new Set<string>();
    let total = 0;
    for (const entry of descriptor.entries) {
      abort(signal);
      const path = assertRelativePath(entry.path, "source bundle path");
      const collisionKey = path.toLocaleLowerCase("en-US");
      if (seen.has(collisionKey)) {
        throw new Error(`duplicate or case-ambiguous source path: ${path}`);
      }
      seen.add(collisionKey);
      if (Buffer.byteLength(path, "utf8") > this.#options.maxPathBytes) {
        throw new Error(`source path exceeds byte limit: ${path}`);
      }
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > this.#options.maxFileBytes
      ) {
        throw new Error(`source file exceeds size limit: ${path}`);
      }
      assertDigest(entry.digest, `source digest for ${path}`);
      total += entry.size;
      if (total > this.#options.maxTotalBytes) {
        throw new Error("source bundle exceeds total byte limit");
      }
      const content = await this.#options.store.content(tenant, entry.contentRef);
      if (content.byteLength !== entry.size) {
        throw new Error(`source size mismatch: ${path}`);
      }
      const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      if (actual !== entry.digest) throw new Error(`source digest mismatch: ${path}`);
      await sandbox.writeFile(path, content, signal);
    }
  }
}

function validateDescriptor(
  descriptor: SourceBundleDescriptor,
  run: VerificationRun,
  limits: Required<Omit<DeterministicSourceBundleMaterializerOptions, "store">>,
): void {
  if (
    descriptor.schemaVersion !== "reef.source-bundle.v1" ||
    descriptor.unicodeNormalization !== "NFC"
  ) {
    throw new Error("unsupported source bundle descriptor");
  }
  if (
    descriptor.organisationRef !== run.organisationRef ||
    descriptor.projectRef !== run.projectRef ||
    descriptor.sourceBundleRef !== run.sourceBundleRef ||
    descriptor.sourceBundleDigest !== run.sourceBundleDigest
  ) {
    throw new Error("source bundle identity does not match verification run");
  }
  if (descriptor.entries.length < 1 || descriptor.entries.length > limits.maxFiles) {
    throw new Error("source bundle file count is outside limits");
  }
  const canonical = computeBundleDigest({
    schemaVersion: descriptor.schemaVersion,
    organisationRef: descriptor.organisationRef,
    projectRef: descriptor.projectRef,
    sourceBundleRef: descriptor.sourceBundleRef,
    unicodeNormalization: descriptor.unicodeNormalization,
    entries: descriptor.entries,
  });
  if (canonical !== descriptor.sourceBundleDigest) {
    throw new Error("source bundle descriptor digest mismatch");
  }
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("verification aborted");
}
