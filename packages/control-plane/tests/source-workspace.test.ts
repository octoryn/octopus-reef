import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommandRunner } from "../src/adapters/local.js";
import type { SandboxExecutionResult } from "../src/types.js";
import { codeCommitCloneUrl } from "../src/source-binding.js";
import {
  prepareSourceWorkspace,
  SourceWorkspaceError,
} from "../src/source-workspace.js";

const REGION = "ap-southeast-2";
const REPO = "reef-src-org-proj";
const REVISION = "d".repeat(40);
const BUNDLE_DIGEST = `sha256:${"e".repeat(64)}`;
const CLONE_URL = codeCommitCloneUrl(REGION, REPO);

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

function mintBinding(): Record<string, unknown> {
  const payload = {
    schemaVersion: "octopus.reef.builder-source-bundle-binding/v1",
    contractVersion: "2.0.0",
    organisationRef: "org-1",
    projectRef: "proj-1",
    sourceBundleRef: `source-bundle:${BUNDLE_DIGEST}`,
    sourceBundleDigest: BUNDLE_DIGEST,
    git: {
      provider: "aws-codecommit",
      repositoryName: REPO,
      cloneUrl: CLONE_URL,
      revision: REVISION,
      branch: "materialized/x",
      region: REGION,
      authMode: "aws-iam-git-codecommit",
    },
  };
  const bindingDigest = `sha256:${createHash("sha256")
    .update(canonicalize(payload))
    .digest("hex")}`;
  return { ...payload, bindingDigest };
}

interface RecordedCall {
  readonly argv: readonly string[];
  readonly cwd?: string;
}

function recordingRunner(
  responder: (argv: readonly string[]) => SandboxExecutionResult,
): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = {
    run(argv, options = {}) {
      calls.push({ argv, ...(options.cwd ? { cwd: options.cwd } : {}) });
      return Promise.resolve(responder(argv));
    },
  };
  return { runner, calls };
}

const ok = (stdout = ""): SandboxExecutionResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

test("clones the sealed revision with an IAM credential helper and no persistent config", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "reef-src-"));
  try {
    const { runner, calls } = recordingRunner((argv) =>
      argv.includes("rev-parse") ? ok(`${REVISION}\n`) : ok(),
    );
    const prepared = await prepareSourceWorkspace({
      binding: mintBinding(),
      scope: { organisationId: "org-1", projectId: "proj-1" },
      workspacePath,
      runner,
    });
    assert.equal(prepared.cloned, true);
    assert.equal(prepared.revision, REVISION);

    const clone = calls.find((c) => c.argv.includes("clone"))!;
    assert.ok(clone, "expected a git clone");
    // IAM credential helper is configured inline; inherited helpers cleared.
    assert.ok(clone.argv.includes("credential.helper="));
    assert.ok(
      clone.argv.includes(
        "credential.helper=!aws codecommit credential-helper $@",
      ),
    );
    assert.ok(clone.argv.includes("credential.UseHttpPath=true"));
    assert.ok(clone.argv.includes("--no-checkout"));
    assert.ok(clone.argv.includes(CLONE_URL));
    assert.ok(clone.argv.includes(workspacePath));

    const checkout = calls.find((c) => c.argv.includes("checkout"))!;
    assert.deepEqual(checkout.argv, ["git", "checkout", "--detach", REVISION]);
    assert.equal(checkout.cwd, workspacePath);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("fails closed on a scope mismatch before running any git command", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "reef-src-"));
  try {
    const { runner, calls } = recordingRunner(() => ok());
    await assert.rejects(
      prepareSourceWorkspace({
        binding: mintBinding(),
        scope: { organisationId: "org-OTHER", projectId: "proj-1" },
        workspacePath,
        runner,
      }),
      /tenant scope/,
    );
    assert.equal(calls.length, 0, "no git command should run for a bad scope");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("fails closed when the checked-out HEAD does not equal the sealed revision", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "reef-src-"));
  try {
    const { runner } = recordingRunner((argv) =>
      argv.includes("rev-parse") ? ok(`${"f".repeat(40)}\n`) : ok(),
    );
    await assert.rejects(
      prepareSourceWorkspace({
        binding: mintBinding(),
        scope: { organisationId: "org-1", projectId: "proj-1" },
        workspacePath,
        runner,
      }),
      SourceWorkspaceError,
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("fails closed when git clone exits non-zero", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "reef-src-"));
  try {
    const { runner } = recordingRunner((argv) =>
      argv.includes("clone")
        ? { exitCode: 128, stdout: "", stderr: "auth denied" }
        : ok(),
    );
    await assert.rejects(
      prepareSourceWorkspace({
        binding: mintBinding(),
        scope: { organisationId: "org-1", projectId: "proj-1" },
        workspacePath,
        runner,
      }),
      /git clone .* failed/,
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("is idempotent: an already-materialised workspace is reused, not re-cloned", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "reef-src-"));
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  try {
    const { runner, calls } = recordingRunner(() => ok());
    const prepared = await prepareSourceWorkspace({
      binding: mintBinding(),
      scope: { organisationId: "org-1", projectId: "proj-1" },
      workspacePath,
      runner,
    });
    assert.equal(prepared.cloned, false);
    assert.equal(calls.length, 0, "no git command for an existing workspace");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
