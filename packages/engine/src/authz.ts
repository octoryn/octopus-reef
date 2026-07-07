/**
 * Authorization ports + the Reef allowlist — the REAL command gate (M1b).
 *
 * `DefaultGate` (gate.ts) is a tripwire that only blocks obvious catastrophes.
 * The real "may this run?" decision is an allowlist: allow-known-safe, else deny.
 * These ports are structurally identical to `octopus-runtime`'s
 * `Principal`/`Authorizer`, so a commercial RBAC/OIDC `Authorizer` drops in
 * behind the same interface — the engine stays offline and dependency-free.
 *
 * A real command NEVER runs on the strength of a denylist. It must (1) pass the
 * tripwire, (2) be authorized here, and (3) be executed by a confined executor.
 */

/** Who is acting. Structurally compatible with `octopus-runtime`'s Principal. */
export interface Principal {
  readonly id: string;
  readonly roles: readonly string[];
  readonly source: string;
  readonly tenantId?: string;
  readonly displayName?: string;
}

/** Authorizes *who may do what*. Compatible with `octopus-runtime`'s Authorizer. */
export interface Authorizer {
  can(
    principal: Principal,
    action: string,
    resource?: { readonly type: string; readonly id: string },
  ): boolean | Promise<boolean>;
}

/** The single-user local owner — the open default principal. */
export const LOCAL_PRINCIPAL: Principal = Object.freeze({
  id: "local",
  roles: Object.freeze(["owner"]) as readonly string[],
  source: "local",
  displayName: "Local user",
});

/** Allow everything — preserves the pre-allowlist behaviour (safe only when the
 * executor runs nothing, e.g. the NoopExecutor). NOT for real execution. */
export const allowAll: Authorizer = { can: (): boolean => true };

/**
 * Combine authorizers so an action is permitted only if EVERY one allows it,
 * short-circuiting on the first denial. This is how the command allowlist
 * (`reefAllowlist` — *what* may run) stacks under an RBAC/OIDC authorizer (e.g.
 * `octopus-runtime`'s — *who* may act): both must agree. With no authorizers it
 * denies (an empty conjunction that grants nothing is the safe default here).
 */
export function requireAll(...authorizers: readonly Authorizer[]): Authorizer {
  return {
    async can(principal, action, resource) {
      if (authorizers.length === 0) return false;
      for (const authorizer of authorizers) {
        if (!(await authorizer.can(principal, action, resource))) return false;
      }
      return true;
    },
  };
}

/**
 * The command allowlist: a SMALL set of build/VCS tools. `"*"` = any args;
 * array = allowed subcommands.
 *
 * Deliberately NO general file-read tools (cat/ls/grep/head/tail): once a
 * command actually executes, such a "read-only" binary is a filesystem-exfil
 * channel — it prints any readable file straight back into the agent's context
 * (review M1b-3 HIGH). Reads go through Reef's CONFINED `read`/`search` actions,
 * not the shell. What remains is version/inspection of the toolchain plus
 * read-only git; git's config-driven code-execution is neutralised by the
 * sandbox (see sandbox.ts hardenGitArgv + a throwaway HOME).
 */
const READ_ONLY: Readonly<Record<string, readonly string[] | "*">> = {
  node: ["--version", "-v"],
  npm: ["--version", "-v", "list", "ls"],
  python3: ["--version"],
  // Only git subcommands that are read-only for ALL arguments. `remote` and
  // `branch` are excluded: `remote add`/`set-url` write config + reach the
  // network and `branch -D` deletes — the subcommand alone can't distinguish
  // their read-only forms (review M1b MED).
  git: ["status", "diff", "log", "show", "rev-parse", "ls-files"],
};

/** Any shell operator, substitution, or redirection disqualifies a "simple" command. */
const SHELL_OPS = /[;&|`$><\n]|\$\(/;

/** git global options that consume the FOLLOWING token as their value. */
const GIT_ARG_FLAGS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

/**
 * The git subcommand, skipping benign global options (`--no-pager`, `-C <path>`,
 * `--git-dir=…`, …) so `git --no-pager log` / `git -C /repo status` still parse.
 * Returns null — a hard deny — for options that can run arbitrary code: `-c`/
 * `--config-env` (config injection, e.g. a hostile `core.pager`) and
 * `--exec-path` (relocates git's helper binaries).
 */
function gitSubcommand(tokens: readonly string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (
      t.startsWith("-c") || // -c <cfg> and any attached -c<cfg> form
      t.startsWith("--config-env") ||
      t.startsWith("--exec-path")
    ) {
      return null; // code-execution vectors — never allow
    }
    if (GIT_ARG_FLAGS.has(t)) {
      i++; // skip this flag's argument
      continue;
    }
    if (t.startsWith("-")) continue; // boolean flag or --flag=value
    return t; // first non-flag token is the subcommand
  }
  return null;
}

export interface ReefAllowlistOptions {
  /** Permit `edit` actions (writes are confined by the executor). Default true. */
  readonly allowEdit?: boolean;
  /** Permit `pr` actions (outward-facing). Default false. */
  readonly allowPr?: boolean;
  /** Override the command allowlist (binary → allowed subcommands or "*"). */
  readonly commands?: Readonly<Record<string, readonly string[] | "*">>;
}

/**
 * The Reef allowlist: allow read-only actions and a small set of read-only
 * commands (no shell operators); deny everything else — including any command
 * that isn't a recognised safe binary, or that contains a shell operator.
 */
export function reefAllowlist(options: ReefAllowlistOptions = {}): Authorizer {
  const commands = options.commands ?? READ_ONLY;
  return {
    can(
      _principal: Principal,
      action: string,
      resource?: { readonly type: string; readonly id: string },
    ): boolean {
      const type = action.startsWith("reef.action.")
        ? action.slice("reef.action.".length)
        : action;
      if (type === "read" || type === "search" || type === "message")
        return true;
      if (type === "edit") return options.allowEdit !== false;
      if (type === "pr") return options.allowPr === true;
      if (type !== "command") return false;

      const cmd = (resource?.id ?? "").trim();
      if (cmd === "" || SHELL_OPS.test(cmd)) return false;
      const tokens = cmd.split(/\s+/);
      const bin = tokens[0]!;
      const allowed = commands[bin];
      if (allowed === undefined) return false;
      if (allowed === "*") return true;
      const sub = bin === "git" ? gitSubcommand(tokens) : tokens[1];
      if (sub === null || sub === undefined) return false;
      return allowed.includes(sub);
    },
  };
}
