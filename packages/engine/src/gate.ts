/**
 * The action gate — Reef's "gate before execute" seam.
 *
 * Every action an agent proposes passes through a gate BEFORE it runs. A denied
 * action is never executed; the denial itself is recorded as evidence.
 *
 * IMPORTANT — honest scope: {@link DefaultGate} is a conservative *denylist
 * backstop*, not a sandbox. A denylist of shell patterns can never be complete;
 * a determined caller can obfuscate around any rule. The real, allowlist-based
 * policy gate is `octopus-runtime` (Principal + decision), wired in behind this
 * same {@link ActionGate} interface at milestone M6 (see docs/DELIVERY-PLAN.md).
 * Until then this catches the obvious catastrophic patterns and nothing more.
 */
import type { ActionRequest, GateVerdict } from "./types.js";

/** Root-ish targets whose destructive modification is catastrophic. */
const DANGEROUS_TARGETS = new Set([
  "/",
  "/*",
  "~",
  "~/",
  "~/*",
  "$HOME",
  "$HOME/",
  "*",
  ".",
  "..",
  "./",
  "../",
]);
const DANGEROUS_ROOT_DIR =
  /^\/(?:root|etc|usr|var|bin|lib|home|boot|sys|opt|dev|sbin|proc)\b/i;

/** The substring after the first occurrence of `keyword`, or null. */
function after(command: string, keyword: string): string | null {
  const m = new RegExp(`\\b${keyword}\\b`, "i").exec(command);
  return m ? command.slice(m.index + m[0].length) : null;
}

/** Non-flag operands of a command tail, unquoted. */
function operandsOf(rest: string): string[] {
  return rest
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith("-"))
    .map((t) => t.replace(/^["']|["']$/g, ""));
}

function targetsRoot(rest: string): boolean {
  return operandsOf(rest).some(
    (t) => DANGEROUS_TARGETS.has(t) || DANGEROUS_ROOT_DIR.test(t),
  );
}

/** `rm` with recursive AND force flags against a root-ish target. */
function isDangerousRm(command: string): boolean {
  const rest = after(command, "rm");
  if (rest === null) return false;
  const recursive = /(?:^|\s)-\w*r/i.test(rest) || /--recursive/i.test(rest);
  const force = /(?:^|\s)-\w*f/i.test(rest) || /--force/i.test(rest);
  return recursive && force && targetsRoot(rest);
}

/** recursive `chown` against a root-ish target. */
function isDangerousChown(command: string): boolean {
  const rest = after(command, "chown");
  if (rest === null) return false;
  const recursive = /(?:^|\s)-[a-z]*R/.test(rest) || /--recursive/i.test(rest);
  return recursive && targetsRoot(rest);
}

/** world-writable `chmod 777` against a root-ish target (with or without -R). */
function isDangerousChmod(command: string): boolean {
  const rest = after(command, "chmod");
  if (rest === null) return false;
  return /\b0*777\b/.test(rest) && targetsRoot(rest);
}

/** force-push to a protected branch — via a --force/-f flag OR a `+` refspec. */
function isForcePush(command: string): boolean {
  if (!/\bgit\s+push\b/i.test(command)) return false;
  const protectedBranch =
    /(?:^|[\s:/+])(?:main|master|production|release|prod)(?:[\s:/]|$)/i;
  if (!protectedBranch.test(command)) return false;
  const forceFlag =
    /--force(?:-with-lease)?\b/i.test(command) ||
    /(?:^|\s)-\w*f\b/i.test(command);
  const plusRefspec =
    /(?:^|\s)\+(?:refs\/|[\w./-]*(?:main|master|production|release|prod))/i.test(
      command,
    );
  return forceFlag || plusRefspec;
}

/** Non-rm/chown/chmod/git catastrophic patterns, matched case-insensitively. */
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /:\s*\(\)\s*\{\s*:\s*\|\s*:?\s*&?\s*\}\s*;/, // fork bomb
  /\bmkfs\.\w+\b|\bmke2fs\b/i, // format a filesystem
  /\bdd\b[^\n]*\bof=\/dev\/[a-z]/i, // dd to a raw device
  /\b(?:curl|wget|fetch)\b[^\n]*\|[^\n]*\b(?:sh|bash|zsh|dash|python[0-9.]*|perl|ruby|node)\b/i, // pipe-to-shell (any stages)
  /(?:>|\btee\b[^\n]*)\s*\/dev\/(?:sd|nvme|hd|disk|vd)[a-z0-9]/i, // overwrite a raw disk (redirect or tee)
  /\bfind\s+(?:\/|~|\$HOME)[^\n]*(?:-delete\b|-exec\s+rm\b)/i, // find / ... -delete | -exec rm
];

/** Extract a normalised command string from an action, if it carries one. */
function commandText(action: ActionRequest): string | undefined {
  if (action.type !== "command") return undefined;
  const raw =
    action.payload &&
    typeof action.payload === "object" &&
    "command" in action.payload
      ? action.payload.command
      : (action.target ?? action.summary);
  const s = typeof raw === "string" ? raw : String(raw);
  return s.replace(/\s+/g, " ").trim();
}

/** A pure `echo`/`printf` that cannot execute what it merely prints. */
function isInertEcho(command: string): boolean {
  return /^(?:echo|printf)\s/i.test(command) && !/[|;&`]|\$\(|>/.test(command);
}

export interface ActionGate {
  readonly name: string;
  check(action: ActionRequest): GateVerdict;
}

export class DefaultGate implements ActionGate {
  readonly name = "reef-default-policy";

  check(action: ActionRequest): GateVerdict {
    const command = commandText(action);
    if (command !== undefined && !isInertEcho(command)) {
      const blocked =
        isDangerousRm(command) ||
        isDangerousChown(command) ||
        isDangerousChmod(command) ||
        isForcePush(command) ||
        DANGEROUS_PATTERNS.some((p) => p.test(command));
      if (blocked) {
        return {
          allow: false,
          reason: `command blocked by ${this.name}: matches a prohibited pattern`,
          policy: this.name,
        };
      }
    }
    return { allow: true, reason: "permitted by policy", policy: this.name };
  }
}
