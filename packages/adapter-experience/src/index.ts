/**
 * @octopus-reef/adapter-experience — causal project memory for a governed session.
 *
 * A session doesn't start from nothing: decisions were made before it, for
 * reasons. `octopus-experience` is that organizational, causal memory — it lets
 * a session `remember` why a decision was made and, at open, `ask` for the
 * relevant prior context. Ask *why*, not just *what*.
 *
 * This adapter is where the `octopus-experience` dependency lives, so the engine
 * stays offline. Point it at a persistent sqlite file for a real project, or
 * `:memory:` for an ephemeral store (tests).
 */
import { ProjectMemory, ask, type AskResult } from "octopus-experience";

export { ProjectMemory, ask } from "octopus-experience";
export type { AskResult } from "octopus-experience";

/** Open the project memory at `dbPath` (`":memory:"` for an ephemeral store). */
export function openMemory(dbPath = ":memory:"): ProjectMemory {
  return new ProjectMemory({ dbPath });
}

/**
 * Record a decision (title + the *why*) into project memory, attributed to
 * `actor`. Returns the created node's id so a Reef session can reference it.
 */
export function rememberDecision(
  memory: ProjectMemory,
  title: string,
  why: string,
  actor = "reef",
): string {
  const result = memory.remember({
    nodes: [{ type: "decision", title, body: why, actor }],
  });
  return result.nodes[0]!.id;
}

/** Ask the project memory for context relevant to `query`. */
export function recall(memory: ProjectMemory, query: string): AskResult {
  return ask(memory, query);
}
