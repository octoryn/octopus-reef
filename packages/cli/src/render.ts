/**
 * Terminal rendering for Reef — the "forensic instrument" aesthetic in ANSI:
 * a deep-sea palette with a single signal-teal accent for anything verified.
 * Colour is disabled automatically when stdout is not a TTY or NO_COLOR is set.
 */
import type { ReefEvent, ReefEventKind } from "@octopus-reef/engine";

const enabled =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function sgr(code: string, s: string): string {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  signal: (s: string) => sgr("38;2;61;224;190", s), // #3DE0BE
  amber: (s: string) => sgr("38;2;240;180;84", s), // #F0B454
  danger: (s: string) => sgr("38;2;255;107;107", s), // #FF6B6B
  ink: (s: string) => sgr("38;2;234;242;240", s),
  muted: (s: string) => sgr("38;2;124;154;155", s), // #7C9A9B
  dim: (s: string) => sgr("2", s),
  bold: (s: string) => sgr("1", s),
};

const GLYPH: Record<ReefEventKind, string> = {
  "session.created": "◆",
  "work.transition": "→",
  observation: "◎",
  "action.executed": "✓",
  "action.denied": "⨯",
  message: "·",
  "session.sealed": "▪",
};

export function renderEvent(e: ReefEvent): string {
  const seq = c.muted(String(e.seq).padStart(2, "0"));
  const hash = c.dim(e.evidenceId.replace(/^ev-/, "").slice(0, 8));
  let glyph: string;
  let text: string;
  switch (e.kind) {
    case "action.denied":
      glyph = c.danger(GLYPH[e.kind]);
      text = c.danger(e.summary);
      break;
    case "action.executed":
    case "session.sealed":
      glyph = c.signal(GLYPH[e.kind]);
      text = c.ink(e.summary);
      break;
    case "work.transition":
      glyph = c.signal(GLYPH[e.kind]);
      text = c.signal(e.summary);
      break;
    default:
      glyph = c.muted(GLYPH[e.kind]);
      text = c.ink(e.summary);
  }
  return `  ${seq} ${glyph} ${text}  ${hash}`;
}

export function banner(): string {
  const title = c.bold(c.signal("Reef"));
  const sub = c.muted(
    "governed agentic engineering · every session is provable",
  );
  return `\n${title} ${c.muted("·")} ${sub}\n`;
}

export function rule(label?: string): string {
  const line = c.dim("─".repeat(58));
  return label
    ? `${c.muted(label)} ${c.dim("─".repeat(Math.max(0, 56 - label.length)))}`
    : line;
}

export function verdictLine(
  ok: boolean,
  work: string,
  log: string,
  binding: string,
): string {
  const mark = ok ? c.signal("✓ verified") : c.danger("⨯ VERIFICATION FAILED");
  const tint = (s: string): string => (ok ? c.signal(s) : c.danger(s));
  return (
    `${mark}  ${c.muted("spine:")} ${tint(work)}  ` +
    `${c.muted("log:")} ${tint(log)}  ${c.muted("binding:")} ${tint(binding)}`
  );
}

export function outcomeLabel(outcome: string): string {
  if (outcome === "completed") return c.signal("completed");
  if (outcome === "cancelled") return c.amber("cancelled");
  return c.danger(outcome);
}
