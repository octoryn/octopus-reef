import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finalizeCandidate,
  autoDetectTestCommand,
  CandidateFinalizeError,
} from "../src/candidate-finalize.js";
import { subprocessCommandRunner } from "../src/adapters/local.js";

const git = async (
  cwd: string,
  argv: readonly string[],
): Promise<string> => {
  const result = await subprocessCommandRunner.run(["git", ...argv], {
    cwd,
    env: {
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@octopus.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@octopus.invalid",
    },
  });
  assert.equal(result.exitCode, 0, `git ${argv.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

async function seedRepo(): Promise<{ readonly dir: string; readonly baseline: string }> {
  const dir = mkdtempSync(join(tmpdir(), "reef-candidate-"));
  await git(dir, ["init", "--quiet"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--quiet", "-m", "baseline"]);
  const baseline = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, baseline };
}

test("finalize captures baseline, commits agent changes, and produces the candidate diff", async () => {
  const { dir, baseline } = await seedRepo();
  try {
    // Simulate the agent's working-tree changes on top of the sealed baseline.
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "added\n");

    const result = await finalizeCandidate({
      workspacePath: dir,
      request: {
        candidateBranch: "reef-candidate/run-1-0",
        commitMessage: "reef: candidate",
        testCommand: { argv: ["node", "-e", "console.log('tests ok')"] },
        push: false,
      },
    });

    assert.equal(result.baseline, baseline);
    assert.notEqual(result.commit, baseline);
    assert.equal(result.changed, true);
    assert.equal(result.pushed, false);
    assert.match(result.diff, /b\.txt/);
    assert.match(result.diff, /\+two/);
    assert.equal(result.test.ran, true);
    assert.equal(result.test.passed, true);
    assert.equal(result.test.exitCode, 0);
    assert.match(result.test.report, /tests ok/);
    // The candidate commit actually contains the changes.
    const committed = await git(dir, ["show", "--stat", result.commit]);
    assert.match(committed, /b\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize pushes the candidate commit to origin on a per-run branch", async () => {
  const { dir } = await seedRepo();
  const origin = mkdtempSync(join(tmpdir(), "reef-candidate-origin-"));
  try {
    await git(origin, ["init", "--bare", "--quiet"]);
    await git(dir, ["remote", "add", "origin", origin]);
    writeFileSync(join(dir, "a.txt"), "pushed\n");

    const result = await finalizeCandidate({
      workspacePath: dir,
      request: {
        candidateBranch: "reef-candidate/run-2-0",
        commitMessage: "reef: candidate push",
        testCommand: { argv: ["node", "-e", "0"] },
        push: true,
      },
    });

    assert.equal(result.pushed, true);
    assert.equal(result.remoteUrl, origin);
    // The per-run branch exists in the origin at exactly the candidate commit.
    const remoteCommit = await git(origin, [
      "rev-parse",
      "refs/heads/reef-candidate/run-2-0",
    ]);
    assert.equal(remoteCommit, result.commit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("finalize reports a failing test suite without failing the run", async () => {
  const { dir } = await seedRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "broken\n");
    const result = await finalizeCandidate({
      workspacePath: dir,
      request: {
        candidateBranch: "reef-candidate/run-3-0",
        commitMessage: "reef: failing tests",
        testCommand: {
          argv: ["node", "-e", "console.error('boom');process.exit(1)"],
        },
        push: false,
      },
    });
    assert.equal(result.test.ran, true);
    assert.equal(result.test.passed, false);
    assert.equal(result.test.exitCode, 1);
    assert.match(result.test.report, /boom/);
    // A candidate commit is still produced for review.
    assert.equal(result.changed, true);
    assert.ok(result.commit.length === 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize commits an empty candidate when the agent made no change", async () => {
  const { dir, baseline } = await seedRepo();
  try {
    const result = await finalizeCandidate({
      workspacePath: dir,
      request: {
        candidateBranch: "reef-candidate/run-4-0",
        commitMessage: "reef: no change",
        testCommand: { argv: ["node", "-e", "0"] },
        push: false,
      },
    });
    assert.equal(result.changed, false);
    assert.notEqual(result.commit, baseline);
    assert.equal(result.diff.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize fails closed when the workspace has no git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-candidate-nogit-"));
  try {
    await assert.rejects(
      finalizeCandidate({
        workspacePath: dir,
        request: {
          candidateBranch: "reef-candidate/run-5-0",
          commitMessage: "no git",
          push: false,
        },
      }),
      CandidateFinalizeError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize rejects a non-canonical candidate branch", async () => {
  const { dir } = await seedRepo();
  try {
    await assert.rejects(
      finalizeCandidate({
        workspacePath: dir,
        request: {
          candidateBranch: "../escape",
          commitMessage: "bad branch",
          push: false,
        },
      }),
      CandidateFinalizeError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autoDetectTestCommand honours the per-project test contract", () => {
  const py = mkdtempSync(join(tmpdir(), "reef-detect-py-"));
  const node = mkdtempSync(join(tmpdir(), "reef-detect-node-"));
  const empty = mkdtempSync(join(tmpdir(), "reef-detect-empty-"));
  try {
    writeFileSync(join(py, "pyproject.toml"), "[project]\nname='x'\n");
    assert.deepEqual(autoDetectTestCommand(py)?.argv, [
      "python",
      "-m",
      "pytest",
      "-q",
    ]);

    writeFileSync(
      join(node, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    assert.deepEqual(autoDetectTestCommand(node)?.argv, [
      "npm",
      "test",
      "--silent",
    ]);

    mkdirSync(join(empty, "src"), { recursive: true });
    assert.equal(autoDetectTestCommand(empty), undefined);
  } finally {
    for (const dir of [py, node, empty]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
