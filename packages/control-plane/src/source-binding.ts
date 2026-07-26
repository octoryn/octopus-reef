import { createHash, timingSafeEqual } from "node:crypto";
import type { TenantScope } from "./types.js";

/**
 * Reef-side consumer of the Builder -> Reef source-materialization binding.
 *
 * When Builder dispatches an AgentRun it first materialises the immutable
 * compiled Foundation source bundle (`octopus.builder.source-bundle/v1`) into a
 * managed, IAM-authenticated private Git repository (AWS CodeCommit) at one
 * immutable commit, then hands the Reef control plane an opaque, digest-sealed
 * binding over the run metadata channel under
 * `octopus.reef.builder-source-bundle-binding/v1`. The binding carries no
 * credentials: authentication is IAM (git-codecommit credential helper) resolved
 * by the Reef sandbox task role. The `git.cloneUrl` never contains secrets.
 *
 * This module is the fail-closed gate the sandbox runner (or any workspace
 * preparation step) runs before cloning: it re-derives the canonical payload,
 * verifies the sealed digest with a constant-time compare, and confirms the
 * binding was minted for the run's own tenant scope. It is a byte-for-byte
 * mirror of the Builder contract in
 * `lib/octopus/reef-source-materialization-binding.ts` so digests match exactly;
 * the schema identifiers MUST stay aligned with the pinned materialization
 * contract (`materialization` in `reef-0.4.1-evaluation-pin.json`).
 */

/** Run-metadata key that carries the digest-sealed source binding. */
export const BUILDER_SOURCE_BUNDLE_BINDING_METADATA_KEY =
  "octopus.reef.builder-source-bundle-binding/v1" as const;

export const BUILDER_SOURCE_BUNDLE_BINDING_SCHEMA =
  "octopus.reef.builder-source-bundle-binding/v1" as const;

export const BUILDER_MATERIALIZATION_CONTRACT_VERSION = "2.0.0" as const;

export const BUILDER_SOURCE_BUNDLE_DESCRIPTOR_SCHEMA =
  "octopus.builder.source-bundle/v1" as const;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BUNDLE_REF_PATTERN = /^source-bundle:sha256:[a-f0-9]{64}$/;
const COMMIT_ID_PATTERN = /^[a-f0-9]{40}$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;
const CODECOMMIT_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/;
const MAX_REF_BYTES = 512;

export type BuilderSourceBindingErrorCode =
  | "SOURCE_BINDING_INVALID"
  | "SOURCE_BINDING_DIGEST_MISMATCH"
  | "SOURCE_BINDING_SCOPE_MISMATCH";

export class BuilderSourceBindingError extends Error {
  readonly code: BuilderSourceBindingErrorCode;

  constructor(code: BuilderSourceBindingErrorCode, message: string) {
    super(message);
    this.name = "BuilderSourceBindingError";
    this.code = code;
  }
}

/** Git coordinates of the materialised, immutable source revision. */
export interface BuilderSourceGitCoordinates {
  readonly provider: "aws-codecommit";
  readonly repositoryName: string;
  /** HTTPS git-codecommit clone URL; never contains credentials. */
  readonly cloneUrl: string;
  /** Immutable 40-hex commit id the sandbox must check out. */
  readonly revision: string;
  /** Content-addressed handle branch; the revision, not the branch, is truth. */
  readonly branch: string;
  readonly region: string;
  /** Reef resolves credentials from its task role; Builder never sends any. */
  readonly authMode: "aws-iam-git-codecommit";
}

export interface BuilderSourceBinding {
  readonly schemaVersion: typeof BUILDER_SOURCE_BUNDLE_BINDING_SCHEMA;
  readonly contractVersion: typeof BUILDER_MATERIALIZATION_CONTRACT_VERSION;
  readonly organisationRef: string;
  readonly projectRef: string;
  /** The immutable bundle this revision was materialised from. */
  readonly sourceBundleRef: string;
  readonly sourceBundleDigest: string;
  readonly git: BuilderSourceGitCoordinates;
  /** SHA-256 over the canonical binding payload (excluding this field). */
  readonly bindingDigest: string;
}

interface BindingCoordinatesInput {
  readonly organisationRef: string;
  readonly projectRef: string;
  readonly sourceBundleRef: string;
  readonly sourceBundleDigest: string;
  readonly git: BuilderSourceGitCoordinates;
}

function invalid(message: string): never {
  throw new BuilderSourceBindingError("SOURCE_BINDING_INVALID", message);
}

function canonicalRef(name: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_REF_BYTES ||
    /\p{Cc}/u.test(value)
  ) {
    invalid(
      `${name} must be a non-empty canonical reference without control characters.`,
    );
  }
  return value;
}

/**
 * Canonical, sorted-key JSON serialisation. Kept local so the binding digest is
 * self-contained and matches the Builder minting side byte-for-byte.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
}

/** Canonical, credential-free HTTPS clone URL for a CodeCommit repository. */
export function codeCommitCloneUrl(
  region: string,
  repositoryName: string,
): string {
  return `https://git-codecommit.${region}.amazonaws.com/v1/repos/${repositoryName}`;
}

function validateGit(
  git: BuilderSourceGitCoordinates,
): BuilderSourceGitCoordinates {
  if (!git || typeof git !== "object") {
    invalid("Source binding git coordinates are required.");
  }
  if (git.provider !== "aws-codecommit") {
    invalid(
      "Only the aws-codecommit source materialization provider is supported.",
    );
  }
  if (git.authMode !== "aws-iam-git-codecommit") {
    invalid("Source binding auth mode must be aws-iam-git-codecommit.");
  }
  const region = canonicalRef("git.region", git.region);
  if (!AWS_REGION_PATTERN.test(region)) {
    invalid("Source binding git.region must be a canonical AWS region.");
  }
  const repositoryName = canonicalRef("git.repositoryName", git.repositoryName);
  if (!CODECOMMIT_REPO_PATTERN.test(repositoryName)) {
    invalid(
      "Source binding git.repositoryName must be a valid CodeCommit repository name.",
    );
  }
  if (
    typeof git.revision !== "string" ||
    !COMMIT_ID_PATTERN.test(git.revision)
  ) {
    invalid(
      "Source binding git.revision must be an immutable 40-hex commit id.",
    );
  }
  const branch = canonicalRef("git.branch", git.branch);
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..")) {
    invalid("Source binding git.branch must be a canonical Git branch name.");
  }
  const expectedCloneUrl = codeCommitCloneUrl(region, repositoryName);
  if (git.cloneUrl !== expectedCloneUrl) {
    invalid(
      "Source binding git.cloneUrl must be the canonical HTTPS CodeCommit URL.",
    );
  }
  return Object.freeze({
    provider: "aws-codecommit",
    repositoryName,
    cloneUrl: expectedCloneUrl,
    revision: git.revision,
    branch,
    region,
    authMode: "aws-iam-git-codecommit",
  });
}

function bindingPayload(input: BindingCoordinatesInput) {
  const organisationRef = canonicalRef(
    "organisationRef",
    input.organisationRef,
  );
  const projectRef = canonicalRef("projectRef", input.projectRef);
  const sourceBundleRef = canonicalRef(
    "sourceBundleRef",
    input.sourceBundleRef,
  );
  const sourceBundleDigest = canonicalRef(
    "sourceBundleDigest",
    input.sourceBundleDigest,
  );
  if (!BUNDLE_REF_PATTERN.test(sourceBundleRef)) {
    invalid(
      "sourceBundleRef must be an opaque source-bundle sha256 reference.",
    );
  }
  if (!SHA256_PATTERN.test(sourceBundleDigest)) {
    invalid("sourceBundleDigest must be a canonical lowercase sha256 digest.");
  }
  if (sourceBundleRef !== `source-bundle:${sourceBundleDigest}`) {
    invalid(
      "sourceBundleRef must be the content address of sourceBundleDigest.",
    );
  }
  const git = validateGit(input.git);
  return {
    schemaVersion: BUILDER_SOURCE_BUNDLE_BINDING_SCHEMA,
    contractVersion: BUILDER_MATERIALIZATION_CONTRACT_VERSION,
    organisationRef,
    projectRef,
    sourceBundleRef,
    sourceBundleDigest,
    git,
  };
}

function bindingDigestOf(payload: ReturnType<typeof bindingPayload>): string {
  return `sha256:${createHash("sha256").update(canonicalize(payload)).digest("hex")}`;
}

/**
 * Re-validates an untrusted binding (read back from run metadata or a remote
 * hand-off) and confirms its sealed digest with a constant-time compare.
 * Returns a frozen, canonical copy or throws. Callers MUST never consume a
 * binding without this gate.
 */
export function assertBuilderSourceBinding(
  value: unknown,
): BuilderSourceBinding {
  if (!value || typeof value !== "object") {
    invalid("Source binding must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== BUILDER_SOURCE_BUNDLE_BINDING_SCHEMA) {
    invalid("Source binding schema version is unsupported.");
  }
  if (candidate.contractVersion !== BUILDER_MATERIALIZATION_CONTRACT_VERSION) {
    invalid("Source binding materialization contract version is unsupported.");
  }
  const payload = bindingPayload({
    organisationRef: candidate.organisationRef as string,
    projectRef: candidate.projectRef as string,
    sourceBundleRef: candidate.sourceBundleRef as string,
    sourceBundleDigest: candidate.sourceBundleDigest as string,
    git: candidate.git as BuilderSourceGitCoordinates,
  });
  const expectedDigest = bindingDigestOf(payload);
  if (typeof candidate.bindingDigest !== "string") {
    invalid("Source binding is missing its sealed digest.");
  }
  const provided = Buffer.from(candidate.bindingDigest, "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new BuilderSourceBindingError(
      "SOURCE_BINDING_DIGEST_MISMATCH",
      "Source binding digest does not seal its canonical payload.",
    );
  }
  return Object.freeze({ ...payload, bindingDigest: expectedDigest });
}

/**
 * Validates the binding's digest seal AND that it was minted for this run's own
 * tenant. Fail-closed: a binding whose scope does not equal the run scope is
 * rejected so a binding issued for one tenant can never be replayed into
 * another tenant's sandbox.
 */
export function assertBuilderSourceBindingForScope(
  value: unknown,
  scope: TenantScope,
): BuilderSourceBinding {
  const binding = assertBuilderSourceBinding(value);
  if (
    binding.organisationRef !== scope.organisationId ||
    binding.projectRef !== scope.projectId
  ) {
    throw new BuilderSourceBindingError(
      "SOURCE_BINDING_SCOPE_MISMATCH",
      "Source binding tenant scope does not match the run scope.",
    );
  }
  return binding;
}
