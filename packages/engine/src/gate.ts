/**
 * DefaultGate — a best-effort ACCIDENT TRIPWIRE, **not** a security boundary.
 *
 * ⚠️ This catches obvious, unobfuscated catastrophic commands (`rm -rf /`, fork
 * bombs, pipe-to-shell, raw-disk overwrites) so an agent does not destroy the
 * machine BY ACCIDENT. It is a denylist, and a denylist over shell can never be
 * complete: a determined caller can obfuscate around it (quoting, `${IFS}`,
 * base64, `eval`, novel tools). **Do NOT rely on it to contain an adversarial
 * agent.** After review rounds R1–R4 kept finding shell bypasses, we stopped
 * treating denylist-completeness as a convergence goal and scoped this honestly.
 *
 * Real command-execution safety is the driver's responsibility (M1): commands
 * run under `octopus-runtime`'s allowlist policy AND an OS sandbox, never on the
 * strength of this pattern match. See docs/DELIVERY-PLAN.md (M1) and the
 * {@link ActionGate} interface — a stricter gate drops in behind it unchanged.
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

/**
 * Normalise a command for detection: drop quotes and expand `${IFS}`/`$IFS` so
 * `rm '-rf' '/'` and `rm${IFS}-rf${IFS}/` read like `rm -rf /`. (Structural
 * splitting/echo-detection runs on the RAW command; only the danger predicates
 * see this normalised form.)
 */
function normalizeCmd(s: string): string {
  return s
    .replace(/["']/g, "")
    .replace(/\$\{IFS\}|\$IFS/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Collapse root aliases (`//`, `/.`, `/./`, trailing slash) to detect root. */
function isRootTarget(operand: string): boolean {
  let p = operand
    .replace(/\/{2,}/g, "/")
    .replace(/\/\.(?=\/|$)/g, "/")
    .replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p === "") p = "/";
  return (
    DANGEROUS_TARGETS.has(operand) ||
    DANGEROUS_TARGETS.has(p) ||
    DANGEROUS_ROOT_DIR.test(p)
  );
}

/** The substring after the first occurrence of `keyword`, or null. */
function after(command: string, keyword: string): string | null {
  const m = new RegExp(`\\b${keyword}\\b`, "i").exec(command);
  return m ? command.slice(m.index + m[0].length) : null;
}

/** Non-flag operands of a command tail. */
function operandsOf(rest: string): string[] {
  return rest.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("-"));
}

function targetsRoot(rest: string): boolean {
  return operandsOf(rest).some(isRootTarget);
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

/** Self-contained catastrophic sequences (matched against the whole command). */
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /:\s*\(\)\s*\{\s*:\s*\|\s*:?\s*&?\s*\}\s*;/, // fork bomb
  /\bmkfs\.\w+\b|\bmke2fs\b/i, // format a filesystem
  /\bdd\b[^\n]*\bof=\/dev\/[a-z]/i, // dd to a raw device
  /\b(?:curl|wget|fetch)\b[^\n]*\|[^\n]*\b(?:sh|bash|zsh|dash|python[0-9.]*|perl|ruby|node)\b/i, // fetch → interpreter
  /\|[^\n]*\b(?:sh|bash|zsh|dash|ksh)\b\s*(?:$|[|;&])/i, // anything piped into a bare shell (echo|sh, cat|bash)
  /\bxargs\b[^\n]*\brm\b/i, // piped mass deletion (find / | xargs rm)
  /(?:>|\btee\b[^\n]*)\s*\/dev\/(?:sd|nvme|hd|disk|vd)[a-z0-9]/i, // overwrite a raw disk
  /\bfind\s+(?:\/|~|\$HOME)[^\n]*(?:-delete\b|-exec\s+rm\b)/i, // find / ... -delete | -exec rm
];

/** Extract a command string, spaces/tabs collapsed but NEWLINES PRESERVED. */
function commandText(action: ActionRequest): string | undefined {
  if (action.type !== "command") return undefined;
  const raw =
    action.payload &&
    typeof action.payload === "object" &&
    "command" in action.payload
      ? action.payload.command
      : (action.target ?? action.summary);
  const s = typeof raw === "string" ? raw : String(raw);
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Shell separators that start a NEW statement (a single `|` pipe is NOT one — a
 * pipe stays within a statement so pipe-to-shell patterns can see it). */
const STATEMENT_SEP = /[\n;&]|&&|\|\|/;

/** A single statement that is a pure `echo`/`printf` — prints, can't execute. */
function isInertEcho(statement: string): boolean {
  return (
    /^(?:echo|printf)\b/i.test(statement) && !/[|`\n]|\$\(|>/.test(statement)
  );
}

export interface ActionGate {
  readonly name: string;
  check(action: ActionRequest): GateVerdict;
}

export class DefaultGate implements ActionGate {
  readonly name = "reef-default-policy";

  check(action: ActionRequest): GateVerdict {
    const command = commandText(action);
    if (command !== undefined) {
      const statements = command
        .split(STATEMENT_SEP)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const allInert = statements.length > 0 && statements.every(isInertEcho);
      const blocked =
        !allInert &&
        (DANGEROUS_PATTERNS.some((p) => p.test(normalizeCmd(command))) ||
          statements.some((s) => {
            if (isInertEcho(s)) return false;
            const n = normalizeCmd(s);
            return (
              isDangerousRm(n) ||
              isDangerousChown(n) ||
              isDangerousChmod(n) ||
              isForcePush(n)
            );
          }));
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
