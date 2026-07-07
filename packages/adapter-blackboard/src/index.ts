/**
 * @octopus-reef/adapter-blackboard — shared cognition for parallel agents.
 *
 * Reef governs ONE session; real work often runs SEVERAL agents at once. A
 * blackboard (`octopus-blackboard`) is their shared memory and coordination
 * layer — NOT an orchestrator. Agents `claim` tasks (so two don't do the same
 * work), `release` them, and `note` progress on a hash-chained timeline. That
 * coordination is itself auditable, which is exactly the Reef posture: the
 * multi-agent story is governed, not opaque.
 *
 * This adapter is where the `octopus-blackboard` dependency lives, so the engine
 * stays offline. A session opens one board (via {@link openSessionBoard}) and
 * shares it across its agents; each agent writes under its own name.
 */
import { Board } from "octopus-blackboard";

export { Board } from "octopus-blackboard";

/**
 * Open (or attach to) the shared coordination board for a governed session, held
 * under `boardDir`. `agent` is the identity THIS process writes under; parallel
 * agents open the same `boardDir` under their own names.
 */
export function openSessionBoard(boardDir: string, agent: string): Board {
  return Board.open({ boardDir, agent });
}

/** True if `key` was claimed by `agent` with no conflicting holder. */
export function claimedCleanly(
  board: Board,
  agent: string,
  key: string,
): boolean {
  const result = board.claim(agent, key);
  return result.conflict === null;
}
