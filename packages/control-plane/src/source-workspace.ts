import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  subprocessCommandRunner,
  type CommandRunner,
} from "./adapters/local.js";
import {
  assertBuilderSourceBindingForScope,
  type BuilderSourceBinding,
} from "./source-binding.js";
import type { TenantScope } from "./types.js";

/**
 * Default git credential helper for IAM-authenticated CodeCommit HTTPS clones.
 * Resolves credentials from the ambient sandbox task role — no secret is ever
 * carried in the binding or the clone URL. Overridable for images that ship a
 * different helper (e.g. `git-remote-codecommit`).
 */
export const DEFAULT_CODECOMMIT_CREDENTIAL_HELPER =
  "!aws codecommit credential-helper $@" as const;

/** Bound the clone; a materialised Foundation bundle is small and immutable. */
const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60_000;

/**
 * Ambient AWS variables that let `git-remote-codecommit` / the CodeCommit
 * credential helper resolve the sandbox task role. The subprocess runner uses a
 * strict env allowlist and does NOT inherit these from the parent, so they must
 * be threaded through explicitly for the `git clone`. `AWS_CONTAINER_CREDENTIALS_*`
 * point botocore at the ECS/Fargate task-role credentials endpoint;
 * `AWS_REGION` / `AWS_DEFAULT_REGION` are required for SigV4 signing.
 *
 * These are scoped to the source-materialisation clone only — untrusted agent
 * commands run through `sandbox-runner`'s `childEnvironment`, which strips every
 * `AWS_*` variable so task-role credentials never leak into executed code.
 */
const CODECOMMIT_CREDENTIAL_ENV_PASSTHROUGH = [
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

/**
 * Build the minimal AWS credential environment the CodeCommit clone needs.
 *
 * Passes through the ambient container-credential and region variables when the
 * task set them, and falls back to the binding's own `git.region` for
 * `AWS_REGION` / `AWS_DEFAULT_REGION` so signing has a region even if the task
 * definition omitted one. `HOME` is provided so git and the awscli-based helper
 * can resolve their config/cache dirs under the read-only rootfs. No secret is
 * ever synthesised here — only ambient references are forwarded.
 */
export function codeCommitCredentialEnv(
  region: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CODECOMMIT_CREDENTIAL_ENV_PASSTHROUGH) {
    const value = source[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  if (env.AWS_REGION === undefined) env.AWS_REGION = region;
  if (env.AWS_DEFAULT_REGION === undefined) env.AWS_DEFAULT_REGION = region;
  const home = source.HOME;
  env.HOME = home !== undefined && home !== "" ? home : "/tmp/reef-home";
  return env;
}

export interface PrepareSourceWorkspaceOptions {
  /** Untrusted binding read from run metadata; validated before any git runs. */
  readonly binding: unknown;
  readonly scope: TenantScope;
  /** Absolute workspace directory the sandbox agent will run in. */
  readonly workspacePath: string;
  readonly runner?: CommandRunner;
  /** Git credential helper for IAM CodeCommit auth. */
  readonly credentialHelper?: string;
  readonly timeoutMs?: number;
  /**
   * Ambient environment the AWS credential passthrough is read from. Defaults to
   * the process environment; injectable for tests. Only the container-credential
   * and region variables are forwarded to the clone subprocess.
   */
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

export interface PreparedSourceWorkspace {
  readonly binding: BuilderSourceBinding;
  readonly workspacePath: string;
  readonly revision: string;
  /** False when an already-materialised workspace was reused (crash restore). */
  readonly cloned: boolean;
}

/**
 * Fail-closed source-workspace preparation for the sandbox runner.
 *
 * 1. Validates the binding digest seal and tenant scope (throws otherwise).
 * 2. Clones the IAM-authenticated CodeCommit repository with credentials
 *    resolved from the sandbox task role — never from the binding.
 * 3. Checks out the immutable revision (detached) and verifies HEAD equals it,
 *    so the sandbox can only ever run the exact revision Builder sealed.
 *
 * Idempotent: an existing `.git` workspace (crash/restore) is left untouched.
 * The git config is applied inline via `-c` flags; no global git state is
 * mutated and git's config-driven code execution stays neutralised.
 */
export async function prepareSourceWorkspace(
  options: PrepareSourceWorkspaceOptions,
): Promise<PreparedSourceWorkspace> {
  const binding = assertBuilderSourceBindingForScope(
    options.binding,
    options.scope,
  );
  const runner = options.runner ?? subprocessCommandRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  const helper =
    options.credentialHelper ?? DEFAULT_CODECOMMIT_CREDENTIAL_HELPER;
  const { cloneUrl, revision } = binding.git;
  // AWS task-role credential environment for the CodeCommit clone. The runner's
  // env allowlist drops inherited AWS_* vars, so the git-remote-codecommit /
  // credential-helper subprocess only sees credentials if we forward them here.
  const credentialEnv = codeCommitCredentialEnv(
    binding.git.region,
    options.processEnv,
  );

  if (existsSync(join(options.workspacePath, ".git"))) {
    return {
      binding,
      workspacePath: options.workspacePath,
      revision,
      cloned: false,
    };
  }

  // Inline, non-persistent git config. `credential.helper=` first clears any
  // inherited helper so only the IAM helper can answer; `UseHttpPath=true` is
  // required by the CodeCommit helper to scope credentials to the repo path.
  const configuredGit = [
    "git",
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${helper}`,
    "-c",
    "credential.UseHttpPath=true",
    "-c",
    "protocol.version=2",
  ];

  const clone = await runner.run(
    [
      ...configuredGit,
      "clone",
      "--no-checkout",
      "--origin",
      "origin",
      "--",
      cloneUrl,
      options.workspacePath,
    ],
    { timeoutMs, env: credentialEnv },
  );
  if (clone.exitCode !== 0) {
    throw new SourceWorkspaceError(
      `git clone of the materialised source failed: ${clone.stderr.trim()}`,
    );
  }

  const checkout = await runner.run(["git", "checkout", "--detach", revision], {
    cwd: options.workspacePath,
    timeoutMs,
  });
  if (checkout.exitCode !== 0) {
    throw new SourceWorkspaceError(
      `git checkout of the sealed revision failed: ${checkout.stderr.trim()}`,
    );
  }

  const head = await runner.run(["git", "rev-parse", "HEAD"], {
    cwd: options.workspacePath,
    timeoutMs,
  });
  if (head.exitCode !== 0) {
    throw new SourceWorkspaceError(
      `git rev-parse HEAD failed after checkout: ${head.stderr.trim()}`,
    );
  }
  if (head.stdout.trim() !== revision) {
    throw new SourceWorkspaceError(
      "materialised workspace HEAD does not match the sealed revision",
    );
  }

  return {
    binding,
    workspacePath: options.workspacePath,
    revision,
    cloned: true,
  };
}

export class SourceWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceWorkspaceError";
  }
}
