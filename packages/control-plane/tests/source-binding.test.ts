import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertBuilderSourceBinding,
  assertBuilderSourceBindingForScope,
  BuilderSourceBindingError,
  BUILDER_SOURCE_BUNDLE_BINDING_METADATA_KEY,
  codeCommitCloneUrl,
} from "../src/source-binding.js";

const REGION = "ap-southeast-2";
const REPO = "reef-src-org-proj-abc123";
const REVISION = "a".repeat(40);
const BUNDLE_DIGEST = `sha256:${"b".repeat(64)}`;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
}

/** Mints a valid, digest-sealed binding exactly as the Builder side would. */
function mintBinding(
  overrides: {
    organisationRef?: string;
    projectRef?: string;
  } = {},
): Record<string, unknown> {
  const payload = {
    schemaVersion: BUILDER_SOURCE_BUNDLE_BINDING_METADATA_KEY,
    contractVersion: "2.0.0",
    organisationRef: overrides.organisationRef ?? "org-1",
    projectRef: overrides.projectRef ?? "proj-1",
    sourceBundleRef: `source-bundle:${BUNDLE_DIGEST}`,
    sourceBundleDigest: BUNDLE_DIGEST,
    git: {
      provider: "aws-codecommit",
      repositoryName: REPO,
      cloneUrl: codeCommitCloneUrl(REGION, REPO),
      revision: REVISION,
      branch: "materialized/abc123",
      region: REGION,
      authMode: "aws-iam-git-codecommit",
    },
  };
  const bindingDigest = `sha256:${createHash("sha256")
    .update(canonicalize(payload))
    .digest("hex")}`;
  return { ...payload, bindingDigest };
}

test("accepts a well-formed, digest-sealed binding and returns a frozen copy", () => {
  const binding = assertBuilderSourceBinding(mintBinding());
  assert.equal(binding.git.revision, REVISION);
  assert.equal(binding.git.cloneUrl, codeCommitCloneUrl(REGION, REPO));
  assert.ok(Object.isFrozen(binding));
});

test("rejects a binding whose sealed digest does not cover the payload", () => {
  const tampered = mintBinding();
  (tampered.git as Record<string, unknown>).revision = "c".repeat(40);
  assert.throws(
    () => assertBuilderSourceBinding(tampered),
    (error: unknown) =>
      error instanceof BuilderSourceBindingError &&
      error.code === "SOURCE_BINDING_DIGEST_MISMATCH",
  );
});

test("rejects an unsupported schema or contract version", () => {
  const badSchema = mintBinding();
  badSchema.schemaVersion = "octopus.reef.builder-source-bundle-binding/v2";
  assert.throws(
    () => assertBuilderSourceBinding(badSchema),
    (e: unknown) =>
      e instanceof BuilderSourceBindingError &&
      e.code === "SOURCE_BINDING_INVALID",
  );
  const badContract = mintBinding();
  badContract.contractVersion = "1.0.0";
  assert.throws(
    () => assertBuilderSourceBinding(badContract),
    (e: unknown) =>
      e instanceof BuilderSourceBindingError &&
      e.code === "SOURCE_BINDING_INVALID",
  );
});

test("rejects a non-CodeCommit provider or credential-bearing clone URL", () => {
  const foreign = mintBinding();
  (foreign.git as Record<string, unknown>).cloneUrl =
    "https://user:pass@git-codecommit.ap-southeast-2.amazonaws.com/v1/repos/x";
  assert.throws(
    () => assertBuilderSourceBinding(foreign),
    (e: unknown) => e instanceof BuilderSourceBindingError,
  );
});

test("scope gate accepts a binding minted for the run's own tenant", () => {
  const binding = assertBuilderSourceBindingForScope(
    mintBinding({ organisationRef: "org-9", projectRef: "proj-9" }),
    { organisationId: "org-9", projectId: "proj-9" },
  );
  assert.equal(binding.organisationRef, "org-9");
});

test("scope gate rejects a binding minted for a different tenant", () => {
  assert.throws(
    () =>
      assertBuilderSourceBindingForScope(
        mintBinding({ organisationRef: "org-attacker", projectRef: "proj-1" }),
        { organisationId: "org-victim", projectId: "proj-1" },
      ),
    (e: unknown) =>
      e instanceof BuilderSourceBindingError &&
      e.code === "SOURCE_BINDING_SCOPE_MISMATCH",
  );
});

test("validates a real Builder-minted binding and locks the canonical digest", () => {
  // Golden value produced by the Builder minting side
  // (lib/octopus/reef-source-materialization-binding.ts createBuilderSourceBinding).
  // Any drift in canonicalisation on either side breaks this cross-check.
  const region = "ap-southeast-2";
  const repo = "reef-golden-repo";
  const golden = {
    schemaVersion: "octopus.reef.builder-source-bundle-binding/v1",
    contractVersion: "2.0.0",
    organisationRef: "org-golden",
    projectRef: "proj-golden",
    sourceBundleRef: `source-bundle:sha256:${"9".repeat(64)}`,
    sourceBundleDigest: `sha256:${"9".repeat(64)}`,
    git: {
      provider: "aws-codecommit",
      repositoryName: repo,
      cloneUrl: codeCommitCloneUrl(region, repo),
      revision: "1234567890abcdef1234567890abcdef12345678",
      branch: "materialized/golden",
      region,
      authMode: "aws-iam-git-codecommit",
    },
    bindingDigest:
      "sha256:688963af1562c17343ec005b345cebab67dc81dbdd34e7d5fae09a6973f424d3",
  };
  const binding = assertBuilderSourceBinding(golden);
  assert.equal(binding.bindingDigest, golden.bindingDigest);
});

test("rejects non-object bindings fail-closed", () => {
  for (const value of [null, undefined, "string", 42, []]) {
    assert.throws(
      () => assertBuilderSourceBinding(value),
      (e: unknown) => e instanceof BuilderSourceBindingError,
    );
  }
});
