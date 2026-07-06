/**
 * The action gate — Reef's "unsafe execution is structurally impossible" seam.
 *
 * Every action an agent proposes passes through a gate BEFORE it runs. A denied
 * action is never executed; the denial itself is recorded as evidence. This
 * built-in {@link DefaultGate} is a minimal, honest safety policy; the full
 * `octopus-runtime` Principal/decision gate wires in behind this same interface
 * (see docs/DELIVERY-PLAN.md — Runtime integration is a tracked milestone).
 */
import type { ActionRequest, GateVerdict } from "./types.js";

export interface ActionGate {
  readonly name: string;
  check(action: ActionRequest): GateVerdict;
}

/** Patterns that must never run unattended. Conservative and explicit. */
const DANGEROUS_COMMANDS: readonly RegExp[] = [
  /\brm\s+-rf?\s+(?:--no-preserve-root\s+)?\/(?:\s|$)/, // rm -rf /
  /\bgit\s+push\b(?=.*\B--force\b)(?=.*\b(?:main|master|production)\b)/, // force-push to a protected branch
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
  /\bmkfs\.\w+\b/, // format a filesystem
  /\bdd\b[^\n]*\bof=\/dev\/[a-z]+/, // dd over a raw device
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, // pipe-to-shell
  /\bchmod\s+-R\s+0*777\s+\//, // chmod -R 777 /
];

export class DefaultGate implements ActionGate {
  readonly name = "reef-default-policy";

  check(action: ActionRequest): GateVerdict {
    if (action.type === "command") {
      const command = String(
        (action.payload && "command" in action.payload
          ? action.payload.command
          : undefined) ??
          action.target ??
          action.summary,
      );
      for (const pattern of DANGEROUS_COMMANDS) {
        if (pattern.test(command)) {
          return {
            allow: false,
            reason: `command blocked by ${this.name}: matches a prohibited pattern`,
            policy: this.name,
          };
        }
      }
    }
    return { allow: true, reason: "permitted by policy", policy: this.name };
  }
}
