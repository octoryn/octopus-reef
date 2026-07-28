import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  subprocessCommandRunner,
  type CommandRunner,
} from "./adapters/local.js";
import {
  DEFAULT_CODECOMMIT_CREDENTIAL_HELPER,
  codeCommitCredentialEnv,
} from "./source-workspace.js";
import type {
  SandboxExecution,
  SandboxFinalizeRequest,
  SandboxFinalizeResult,
  SandboxFinalizeTestResult,
} from "./types.js";

/**
 * Candidate materialisation inside the sandbox workspace.
 *
 * The agent session leaves the sandbox working tree modified on top of the
 * sealed baseline revision (detached HEAD). This turns that working tree into a
 * reviewable candidate, entirely inside the sandbox where the git repository,
 * the agent's changes, and the CodeCommit task-role credentials live:
 *
 *   1. record the baseline commit (the sealed revision at HEAD);
 *   2. run the project's test suite (auto-detected or supplied) with the
 *      untrusted-command environment — never with AWS credentials;
 *   3. stage and commit the agent's changes (`--allow-empty` so a candidate
 *      commit always exists) as a durable, content-addressed candidate;
 *   4. capture the unified diff `baseline..candidate`;
 *   5. push the candidate commit to a per-run branch on the materialised
 *      CodeCommit `origin`, so a reviewer can retrieve the exact diff by commit
 *      id. The push — and only the push — receives the CodeCommit credential
 *      environment resolved from the sandbox task role.
 *
 * Fail-closed: any git failure (and a requested push that fails) throws so the
 * run fails with a specific diagnostic rather than fabricating a candidate.
 */

const DEFAULT_MAX_DIFF_BYTES = 1_048_576;
const DEFAULT_MAX_REPORT_BYTES = 262_144;
const DEFAULT_GIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 10 * 60_000;
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/;

export interface FinalizeCandidateOptions {
  /** Absolute sandbox workspace directory holding the git-backed candidate. */
  readonly workspacePath: string;
  readonly request: SandboxFinalizeRequest;
  readonly runner?: CommandRunner;
  /** AWS region used to sign the CodeCommit push. */
  readonly region?: string;
  readonly credentialHelper?: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly maxDiffBytes?: number;
  readonly maxReportBytes?: number;
  readonly gitTimeoutMs?: number;
  /** Ambient environment the AWS credential passthrough is read from. */
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

export class CandidateFinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateFinalizeError";
  }
}

export async function finalizeCandidate(
  options: FinalizeCandidateOptions,
): Promise<SandboxFinalizeResult> {
  const runner = options.runner ?? subprocessCommandRunner;
  const cwd = options.workspacePath;
  const branch = options.request.candidateBranch;
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..")) {
    throw new CandidateFinalizeError(
      `candidate branch is not a canonical Git branch name: ${branch}`,
    );
  }
  if (!existsSync(join(cwd, ".git"))) {
    throw new CandidateFinalizeError(
      "candidate workspace has no git repository to finalise",
    );
  }
  const gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const authorEnv = {
    GIT_AUTHOR_NAME: options.authorName ?? "Octopus Reef Agent",
    GIT_AUTHOR_EMAIL: options.authorEmail ?? "agent@octopus.invalid",
    GIT_COMMITTER_NAME: options.authorName ?? "Octopus Reef Agent",
    GIT_COMMITTER_EMAIL: options.authorEmail ?? "agent@octopus.invalid",
  } as const;

  const git = async (
    argv: readonly string[],
    extraEnv?: Readonly<Record<string, string>>,
  ): Promise<string> => {
    const result = await runner.run(argv, {
      cwd,
      timeoutMs: gitTimeoutMs,
      ...(extraEnv !== undefined ? { env: extraEnv } : {}),
    });
    if (result.exitCode !== 0) {
      throw new CandidateFinalizeError(
        `${argv.slice(0, 2).join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout;
  };

  const baseline = (await git(["git", "rev-parse", "HEAD"])).trim();

  // 1. Run tests BEFORE committing so the report reflects the candidate tree.
  const test = await runTests(runner, cwd, options.request.testCommand, {
    maxReportBytes: options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES,
  });

  // 2. Stage and commit the agent's changes as the candidate.
  await git(["git", "add", "-A"], authorEnv);
  const status = (await git(["git", "status", "--porcelain"])).trim();
  const changed = status !== "";
  await git(
    ["git", "commit", "--allow-empty", "-m", options.request.commitMessage],
    authorEnv,
  );
  const commit = (await git(["git", "rev-parse", "HEAD"])).trim();

  // 3. Capture the unified candidate diff.
  const rawDiff = await git(["git", "diff", `${baseline}..${commit}`]);
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const { text: diff, truncated: diffTruncated } = boundText(
    rawDiff,
    maxDiffBytes,
  );

  // 4. Push the candidate to the materialised CodeCommit origin (only the push
  //    subprocess receives task-role credentials).
  let pushed = false;
  let remoteUrl: string | undefined;
  if (options.request.push === true) {
    remoteUrl = (await git(["git", "remote", "get-url", "origin"])).trim();
    const helper =
      options.credentialHelper ?? DEFAULT_CODECOMMIT_CREDENTIAL_HELPER;
    const credentialEnv = codeCommitCredentialEnv(
      options.region ?? "",
      options.processEnv,
    );
    const push = await runner.run(
      [
        "git",
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helper}`,
        "-c",
        "credential.UseHttpPath=true",
        "-c",
        "protocol.version=2",
        "push",
        "origin",
        `${commit}:refs/heads/${branch}`,
      ],
      { cwd, timeoutMs: gitTimeoutMs, env: credentialEnv },
    );
    if (push.exitCode !== 0) {
      throw new CandidateFinalizeError(
        `candidate push to CodeCommit failed: ${push.stderr.trim() || push.stdout.trim()}`,
      );
    }
    pushed = true;
  }

  return {
    baseline,
    commit,
    branch,
    pushed,
    ...(remoteUrl !== undefined ? { remoteUrl } : {}),
    diff,
    diffTruncated,
    changed,
    test,
  };
}

async function runTests(
  runner: CommandRunner,
  workspacePath: string,
  explicit: SandboxExecution | undefined,
  bounds: { readonly maxReportBytes: number },
): Promise<SandboxFinalizeTestResult> {
  const command = explicit ?? autoDetectTestCommand(workspacePath);
  if (command === undefined) {
    return {
      ran: false,
      command: [],
      exitCode: 0,
      passed: true,
      report: "no test contract detected (no pyproject/pytest or package.json test script)",
      reportTruncated: false,
    };
  }
  const cwd =
    command.cwd !== undefined && command.cwd !== "."
      ? join(workspacePath, command.cwd)
      : workspacePath;
  const result = await runner.run(command.argv, {
    cwd,
    timeoutMs: command.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
    ...(command.env !== undefined ? { env: command.env } : {}),
  });
  const combined =
    result.stdout + (result.stderr === "" ? "" : `\n${result.stderr}`);
  const { text: report, truncated: reportTruncated } = boundText(
    combined,
    bounds.maxReportBytes,
  );
  return {
    ran: true,
    command: command.argv,
    exitCode: result.exitCode,
    passed: result.exitCode === 0,
    report,
    reportTruncated,
  };
}

/**
 * Per-project test contract detection. Backend Python projects run pytest;
 * Node/frontend projects run their `test` script. Returns undefined when no
 * recognised contract is present so the candidate is still reviewable.
 */
export function autoDetectTestCommand(
  workspacePath: string,
): SandboxExecution | undefined {
  for (const marker of ["pyproject.toml", "pytest.ini", "tox.ini", "setup.py"]) {
    if (existsSync(join(workspacePath, marker))) {
      return { argv: ["python", "-m", "pytest", "-q"] };
    }
  }
  const packageJsonPath = join(workspacePath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        readonly scripts?: Readonly<Record<string, unknown>>;
      };
      const testScript = parsed.scripts?.["test"];
      if (typeof testScript === "string" && testScript.trim() !== "") {
        return { argv: ["npm", "test", "--silent"] };
      }
    } catch {
      // Unparseable package.json -> no reliable test contract.
    }
  }
  return undefined;
}

function boundText(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false };
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}
