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

/** Read-only binaries that are safe to allow. `"*"` = any args; array = allowed subcommands. */
const READ_ONLY: Readonly<Record<string, readonly string[] | "*">> = {
  ls: "*",
  pwd: "*",
  echo: "*",
  printf: "*",
  cat: "*",
  head: "*",
  tail: "*",
  wc: "*",
  grep: "*",
  date: "*",
  whoami: "*",
  true: "*",
  false: "*",
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
      return allowed.includes(tokens[1] ?? "");
    },
  };
}
