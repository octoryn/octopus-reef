import type {
  TrustedVerificationProfile,
  VerificationCheckDefinition,
  VerificationRunRequest,
} from "./types.js";
import {
  assertDigest,
  assertRelativePath,
  assertWorkingDirectory,
  computeProfileDigest,
} from "./validation.js";

const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  "BASH_ENV",
  "ENV",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "HOME",
  "IFS",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PATH",
  "PYTHONPATH",
  "RUBYOPT",
  "SHELLOPTS",
  "TMPDIR",
]);

export interface TrustedVerificationProfileRegistry {
  resolve(
    request: Pick<
      VerificationRunRequest,
      | "verificationProfileRef"
      | "verificationProfileVersion"
      | "verificationProfileDigest"
    >,
  ): Promise<TrustedVerificationProfile>;
}

export class StaticVerificationProfileRegistry implements TrustedVerificationProfileRegistry {
  readonly #profiles = new Map<string, TrustedVerificationProfile>();

  constructor(profiles: readonly TrustedVerificationProfile[]) {
    for (const profile of profiles) {
      validateProfile(profile);
      const key = profileKey(profile.ref, profile.version, profile.digest);
      if (this.#profiles.has(key)) throw new Error(`duplicate profile: ${key}`);
      this.#profiles.set(key, structuredClone(profile));
    }
  }

  resolve(
    request: Pick<
      VerificationRunRequest,
      | "verificationProfileRef"
      | "verificationProfileVersion"
      | "verificationProfileDigest"
    >,
  ): Promise<TrustedVerificationProfile> {
    const profile = this.#profiles.get(
      profileKey(
        request.verificationProfileRef,
        request.verificationProfileVersion,
        request.verificationProfileDigest,
      ),
    );
    if (profile === undefined) {
      throw new Error("unknown or mismatched immutable verification profile");
    }
    return Promise.resolve(structuredClone(profile));
  }
}

export function defineTrustedProfile(
  profile: Omit<TrustedVerificationProfile, "digest">,
): TrustedVerificationProfile {
  const value = { ...profile, digest: computeProfileDigest(profile) };
  validateProfile(value);
  return value;
}

export function validateProfile(profile: TrustedVerificationProfile): void {
  exactObject(
    profile,
    [
      "ref",
      "version",
      "digest",
      "sandboxImageDigest",
      "maxDurationMs",
      "maxChecks",
      "checks",
    ],
    "verification profile",
  );
  if (
    typeof profile.ref !== "string" ||
    !profile.ref.includes(":") ||
    profile.ref.includes("://") ||
    profile.ref.includes("\\") ||
    profile.ref !== profile.ref.trim() ||
    /\p{Cc}/u.test(profile.ref)
  )
    throw new Error("profile ref must be opaque");
  if (typeof profile.version !== "string")
    throw new Error("profile version must be a string");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(profile.version)) {
    throw new Error("profile version must be immutable semantic version");
  }
  if (
    typeof profile.digest !== "string" ||
    typeof profile.sandboxImageDigest !== "string"
  ) {
    throw new Error("profile digests must be strings");
  }
  assertDigest(profile.digest, "profile digest");
  assertDigest(profile.sandboxImageDigest, "sandbox image digest");
  const { digest, ...unsigned } = profile;
  void digest;
  if (computeProfileDigest(unsigned) !== profile.digest) {
    throw new Error("profile digest does not match canonical profile content");
  }
  if (
    !Number.isInteger(profile.maxChecks) ||
    profile.maxChecks < 1 ||
    !Array.isArray(profile.checks) ||
    profile.checks.length < 1 ||
    profile.checks.length > profile.maxChecks ||
    !Number.isInteger(profile.maxDurationMs) ||
    profile.maxDurationMs < 1
  ) {
    throw new Error("profile resource budget is invalid");
  }
  const refs = new Set<string>();
  for (const check of profile.checks) validateCheck(check, refs);
}

function validateCheck(
  check: VerificationCheckDefinition,
  refs: Set<string>,
): void {
  exactObject(
    check,
    [
      "checkRef",
      "required",
      "argv",
      "workingDirectory",
      "timeoutMs",
      "outputLimitBytes",
      "environment",
      "secretBindings",
      "tool",
      "expectedArtifacts",
    ],
    "verification check",
    ["secretBindings", "expectedArtifacts"],
  );
  if (
    typeof check.checkRef !== "string" ||
    typeof check.required !== "boolean" ||
    !Array.isArray(check.argv) ||
    typeof check.workingDirectory !== "string" ||
    typeof check.environment !== "object" ||
    check.environment === null ||
    Array.isArray(check.environment)
  )
    throw new Error("verification check runtime schema is invalid");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(check.checkRef)) {
    throw new Error(`invalid check ref: ${check.checkRef}`);
  }
  if (refs.has(check.checkRef))
    throw new Error(`duplicate check: ${check.checkRef}`);
  refs.add(check.checkRef);
  if (
    check.argv.length === 0 ||
    check.argv.length > 128 ||
    check.argv.some(
      (part) =>
        typeof part !== "string" || part.length === 0 || part.length > 32_768,
    )
  ) {
    throw new Error(`invalid argv for check ${check.checkRef}`);
  }
  assertWorkingDirectory(check.workingDirectory);
  if (
    !Number.isInteger(check.timeoutMs) ||
    check.timeoutMs < 1 ||
    !Number.isInteger(check.outputLimitBytes) ||
    check.outputLimitBytes < 1 ||
    check.outputLimitBytes > 16 * 1024 * 1024
  ) {
    throw new Error(`invalid bounds for check ${check.checkRef}`);
  }
  exactObject(
    check.tool,
    ["name", "version", "imageDigest"],
    "verification tool",
  );
  if (
    typeof check.tool.name !== "string" ||
    check.tool.name === "" ||
    typeof check.tool.version !== "string" ||
    check.tool.version === "" ||
    typeof check.tool.imageDigest !== "string"
  )
    throw new Error(`invalid tool identity for check ${check.checkRef}`);
  assertDigest(check.tool.imageDigest, "tool image digest");
  for (const [name, value] of Object.entries(check.environment)) {
    if (!safeEnvironmentName(name)) {
      throw new Error(`unsafe profile environment name: ${name}`);
    }
    if (typeof value !== "string" || value.length > 8192) {
      throw new Error(`profile environment value is invalid: ${name}`);
    }
  }
  if (
    check.secretBindings !== undefined &&
    !Array.isArray(check.secretBindings)
  ) {
    throw new Error(
      `secret bindings must be an array in check ${check.checkRef}`,
    );
  }
  for (const binding of check.secretBindings ?? []) {
    exactObject(
      binding,
      ["name", "secretRef", "environmentName"],
      "verification secret binding",
    );
    if (
      typeof binding.name !== "string" ||
      typeof binding.secretRef !== "string" ||
      typeof binding.environmentName !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(binding.name) ||
      !binding.secretRef.includes(":") ||
      binding.secretRef.includes("://") ||
      !safeEnvironmentName(binding.environmentName)
    ) {
      throw new Error(`unsafe secret binding in check ${check.checkRef}`);
    }
  }
  if (
    check.expectedArtifacts !== undefined &&
    !Array.isArray(check.expectedArtifacts)
  ) {
    throw new Error(
      `expected artifacts must be an array in check ${check.checkRef}`,
    );
  }
  for (const artifact of check.expectedArtifacts ?? []) {
    exactObject(
      artifact,
      ["path", "kind", "mediaType", "required", "maxBytes"],
      "verification expected artifact",
    );
    if (
      typeof artifact.path !== "string" ||
      typeof artifact.kind !== "string" ||
      artifact.kind === "" ||
      typeof artifact.mediaType !== "string" ||
      artifact.mediaType === "" ||
      typeof artifact.required !== "boolean" ||
      !Number.isInteger(artifact.maxBytes)
    )
      throw new Error(`invalid expected artifact in check ${check.checkRef}`);
    assertRelativePath(artifact.path, "artifact path");
    if (artifact.maxBytes < 1 || artifact.maxBytes > 64 * 1024 * 1024) {
      throw new Error(`invalid artifact bound in check ${check.checkRef}`);
    }
  }
}

function exactObject(
  value: object,
  allowed: readonly string[],
  name: string,
  optional: readonly string[] = [],
): void {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  if (
    keys.some((key) => !allowedSet.has(key)) ||
    allowed.some((key) => !optionalSet.has(key) && !(key in record))
  )
    throw new Error(`${name} contains missing or unsupported fields`);
}

function safeEnvironmentName(name: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]*$/.test(name) &&
    !name.startsWith("AWS_") &&
    !name.startsWith("REEF_") &&
    !FORBIDDEN_ENVIRONMENT_NAMES.has(name)
  );
}

function profileKey(ref: string, version: string, digest: string): string {
  return `${ref}\0${version}\0${digest}`;
}
