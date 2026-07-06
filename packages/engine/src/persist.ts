/**
 * Session persistence — the on-disk form of a governed session.
 *
 * A session writes two append-only, git-diffable JSONL artifacts plus a small
 * snapshot:
 *   - `workstate.jsonl`    — the work spine's audit trail (`octopus-workstate`).
 *   - `session.log.jsonl`  — the full evidence log (one record per line).
 *   - `session.json`       — a human-readable snapshot (not authoritative).
 *
 * {@link loadSession} re-verifies BOTH artifacts store-untrusting: it never
 * trusts the files, it re-folds and re-checks them. A tampered file fails to
 * load rather than loading wrong.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkStateGraph, type WorkState } from "octopus-workstate";
import { loadJsonl, saveJsonl } from "octopus-workstate/storage/jsonl";
import { EvidenceLog, type LogRecord } from "./log.js";
import type { GovernedSession } from "./session.js";

const WORK_FILE = "workstate.jsonl";
const LOG_FILE = "session.log.jsonl";
const META_FILE = "session.json";

export interface PersistOptions {
  readonly integritySecret?: string;
}

/** Write a session to `dir`, creating it if needed. */
export function persistSession(session: GovernedSession, dir: string): void {
  mkdirSync(dir, { recursive: true });
  saveJsonl(session.graph, join(dir, WORK_FILE));
  const logText = session.log
    .records()
    .map((record) => JSON.stringify(record))
    .join("\n");
  writeFileSync(join(dir, LOG_FILE), `${logText}\n`, "utf8");
  writeFileSync(
    join(dir, META_FILE),
    `${JSON.stringify(session.snapshot(), null, 2)}\n`,
    "utf8",
  );
}

export interface LoadedSession {
  readonly graph: WorkStateGraph;
  readonly log: EvidenceLog;
  readonly workState: WorkState | undefined;
  readonly workChainLength: number;
  readonly logChainLength: number;
}

/**
 * Load and independently re-verify a persisted session. Throws if either the
 * work trail or the evidence log fails verification. Optionally pin the graph's
 * expected length/head via {@link loadJsonl} options for truncation detection.
 */
export function loadSession(
  dir: string,
  options: PersistOptions = {},
): LoadedSession {
  const graph = loadJsonl(
    join(dir, WORK_FILE),
    options.integritySecret !== undefined
      ? { integritySecret: options.integritySecret }
      : {},
  );

  const raw = readFileSync(join(dir, LOG_FILE), "utf8");
  const records: LogRecord[] = raw
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogRecord);
  const log = EvidenceLog.restore(
    records,
    options.integritySecret !== undefined
      ? { integritySecret: options.integritySecret }
      : {},
  );

  const items = graph.items();
  return {
    graph,
    log,
    workState: items[0]?.state,
    workChainLength: graph.auditChain().length,
    logChainLength: log.length,
  };
}
