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
    { timeoutMs },
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
