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

/** Roots whose recursive+forced deletion is catastrophic. */
const DANGEROUS_RM_TARGETS = new Set([
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
  /^\/(?:root|etc|usr|var|bin|lib|home|boot|sys|opt|dev)\b/i;

/** `rm` with BOTH recursive and force flags against a root-ish target. */
function isDangerousRm(command: string): boolean {
  if (!/\brm\b/i.test(command)) return false;
  const rest = command.slice(command.search(/\brm\b/i) + 2);
  const hasRecursive = /(?:^|\s)-\w*r/i.test(rest) || /--recursive/i.test(rest);
  const hasForce = /(?:^|\s)-\w*f/i.test(rest) || /--force/i.test(rest);
  if (!hasRecursive || !hasForce) return false;
  const operands = rest
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith("-"));
  return operands.some((raw) => {
    const t = raw.replace(/^["']|["']$/g, "");
    return DANGEROUS_RM_TARGETS.has(t) || DANGEROUS_ROOT_DIR.test(t);
  });
}

/** Non-rm catastrophic patterns, matched case-insensitively. */
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  // git force-push (long or short flag) to a protected branch, order-independent.
  /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|(?:^|\s)-\w*f)\b[^\n]*(?:^|[\s:/])(?:main|master|production|release|prod)(?:[\s:/]|$)/i,
  /\bgit\s+push\b[^\n]*(?:^|[\s:/])(?:main|master|production|release|prod)(?:[\s:/]|$)[^\n]*(?:--force(?:-with-lease)?|(?:^|\s)-\w*f)\b/i,
  // fork bomb.
  /:\s*\(\)\s*\{\s*:\s*\|\s*:?\s*&?\s*\}\s*;/,
  // format a filesystem.
  /\bmkfs\.\w+\b|\bmke2fs\b/i,
  // dd writing to a raw device (order-independent).
  /\bdd\b[^\n]*\bof=\/dev\/[a-z]/i,
  // pipe (through ANY number of stages) into a shell/interpreter.
  /\b(?:curl|wget|fetch)\b[^\n]*\|[^\n]*\b(?:sh|bash|zsh|dash|python[0-9.]*|perl|ruby|node)\b/i,
  // world-writable chmod (with or without -R) on a root-ish target.
  /\bchmod\b[^\n]*\b0*777\b[^\n]*(?:^|[\s"'])(?:\/|~|\$HOME)(?:[\s"'/]|$)/i,
  // overwrite a raw disk device.
  />\s*\/dev\/(?:sd|nvme|hd|disk|vd)[a-z0-9]/i,
  // recursive chown of the root.
  /\bchown\b[^\n]*(?:^|\s)-\w*R\w*\b[^\n]*(?:^|\s)\/(?:\s|$)/i,
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

export interface ActionGate {
  readonly name: string;
  check(action: ActionRequest): GateVerdict;
}

export class DefaultGate implements ActionGate {
  readonly name = "reef-default-policy";

  check(action: ActionRequest): GateVerdict {
    const command = commandText(action);
    if (command !== undefined) {
      const blocked =
        isDangerousRm(command) ||
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
