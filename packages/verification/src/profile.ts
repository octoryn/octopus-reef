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

export interface TrustedVerificationProfileRegistry {
  resolve(request: Pick<
    VerificationRunRequest,
    | "verificationProfileRef"
    | "verificationProfileVersion"
    | "verificationProfileDigest"
  >): Promise<TrustedVerificationProfile>;
}

export class StaticVerificationProfileRegistry
  implements TrustedVerificationProfileRegistry
{
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
  if (!profile.ref.includes(":")) throw new Error("profile ref must be opaque");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(profile.version)) {
    throw new Error("profile version must be immutable semantic version");
  }
  assertDigest(profile.digest, "profile digest");
  assertDigest(profile.sandboxImageDigest, "sandbox image digest");
  const { digest: _digest, ...unsigned } = profile;
  if (computeProfileDigest(unsigned) !== profile.digest) {
    throw new Error("profile digest does not match canonical profile content");
  }
  if (
    !Number.isInteger(profile.maxChecks) ||
    profile.maxChecks < 1 ||
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
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(check.checkRef)) {
    throw new Error(`invalid check ref: ${check.checkRef}`);
  }
  if (refs.has(check.checkRef)) throw new Error(`duplicate check: ${check.checkRef}`);
  refs.add(check.checkRef);
  if (
    check.argv.length === 0 ||
    check.argv.length > 128 ||
    check.argv.some((part) => part.length === 0 || part.length > 32_768)
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
  assertDigest(check.tool.imageDigest, "tool image digest");
  for (const [name, value] of Object.entries(check.environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name.startsWith("AWS_") || name.startsWith("REEF_")) {
      throw new Error(`unsafe profile environment name: ${name}`);
    }
    if (value.length > 8192) throw new Error(`profile environment value too large: ${name}`);
  }
  for (const binding of check.secretBindings ?? []) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(binding.name) ||
      !binding.secretRef.includes(":") ||
      !/^[A-Z][A-Z0-9_]*$/.test(binding.environmentName) ||
      binding.environmentName.startsWith("AWS_") ||
      binding.environmentName.startsWith("REEF_")
    ) {
      throw new Error(`unsafe secret binding in check ${check.checkRef}`);
    }
  }
  for (const artifact of check.expectedArtifacts ?? []) {
    assertRelativePath(artifact.path, "artifact path");
    if (artifact.maxBytes < 1 || artifact.maxBytes > 64 * 1024 * 1024) {
      throw new Error(`invalid artifact bound in check ${check.checkRef}`);
    }
  }
}

function profileKey(ref: string, version: string, digest: string): string {
  return `${ref}\0${version}\0${digest}`;
}
