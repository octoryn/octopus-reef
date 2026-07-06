/**
 * Session persistence — the on-disk form of a governed session.
 *
 * A session writes three artifacts (each written atomically: temp + fsync +
 * rename, so a crash never leaves a half-written file):
 *   - `session.log.jsonl`  — the full evidence log (one record per line).
 *   - `workstate.jsonl`    — the work spine's audit trail (`octopus-workstate`).
 *   - `session.json`       — a human-readable snapshot (NOT authoritative).
 *
 * The log is written *before* the spine, and the spine's seal cross-binds them,
 * so a crash between the two writes is detected at load, not loaded wrong.
 *
 * {@link loadSession} re-verifies everything store-untrusting: it re-derives
 * every hash, re-folds both chains, AND checks the two are cross-bound to each
 * other (see {@link verifyBinding}). A tampered, truncated, or mismatched
 * session throws rather than loading wrong.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { WorkStateGraph, type WorkState } from "octopus-workstate";
import { loadJsonl, saveJsonl } from "octopus-workstate/storage/jsonl";
import { EvidenceLog, type LogRecord } from "./log.js";
import { EngineError } from "./json.js";
import { verifyBinding } from "./verify.js";
import type { GovernedSession } from "./session.js";

const WORK_FILE = "workstate.jsonl";
const LOG_FILE = "session.log.jsonl";
const META_FILE = "session.json";

export interface PersistOptions {
  readonly integritySecret?: string;
  /** Out-of-band anchors for extra truncation defense (belt-and-braces). */
  readonly expectedLogLength?: number;
  readonly expectedLogHead?: string;
  readonly expectedWorkLength?: number;
  readonly expectedWorkHead?: string;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Write a session to `dir`, creating it if needed. Log first, then spine. */
export function persistSession(session: GovernedSession, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const logText = session.log
    .records()
    .map((record) => JSON.stringify(record))
    .join("\n");
  atomicWrite(join(dir, LOG_FILE), `${logText}\n`);
  saveJsonl(session.graph, join(dir, WORK_FILE));
  atomicWrite(
    join(dir, META_FILE),
    `${JSON.stringify(session.snapshot(), null, 2)}\n`,
  );
}

export interface LoadedSession {
  readonly graph: WorkStateGraph;
  readonly log: EvidenceLog;
  readonly workState: WorkState | undefined;
  readonly workChainLength: number;
  readonly logChainLength: number;
  /**
   * `true` only when an `integritySecret` was supplied. An *unkeyed* successful
   * load proves the store is self-CONSISTENT (public SHA-256), NOT AUTHENTIC: a
   * writer with file access can re-mint the whole session and it will still
   * load. For an untrusted store, load in keyed mode (or pin `expected*`
   * anchors). Callers should treat `authenticated: false` as "integrity of a
   * trusted store", not "proof against a malicious one".
   */
  readonly authenticated: boolean;
}

/**
 * Load and independently re-verify a persisted session. Throws {@link EngineError}
 * if the work trail, the evidence log, or their cross-binding fails.
 */
export function loadSession(
  dir: string,
  options: PersistOptions = {},
): LoadedSession {
  const graph = loadJsonl(join(dir, WORK_FILE), {
    ...(options.integritySecret !== undefined
      ? { integritySecret: options.integritySecret }
      : {}),
    ...(options.expectedWorkLength !== undefined
      ? { expectedLength: options.expectedWorkLength }
      : {}),
    ...(options.expectedWorkHead !== undefined
      ? { expectedHead: options.expectedWorkHead }
      : {}),
  });

  const raw = readFileSync(join(dir, LOG_FILE), "utf8");
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const records: LogRecord[] = [];
  const lines = body.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as LogRecord);
    } catch {
      throw new EngineError(
        `malformed session log at ${LOG_FILE} line ${i + 1}`,
      );
    }
  }

  const log = EvidenceLog.restore(records, {
    ...(options.integritySecret !== undefined
      ? { integritySecret: options.integritySecret }
      : {}),
    ...(options.expectedLogLength !== undefined
      ? { expectedLength: options.expectedLogLength }
      : {}),
    ...(options.expectedLogHead !== undefined
      ? { expectedHead: options.expectedLogHead }
      : {}),
  });

  const binding = verifyBinding(graph, log);
  if (!binding.ok) {
    throw new EngineError(`session cross-binding failed: ${binding.reason}`);
  }

  const items = graph.items();
  return {
    graph,
    log,
    workState: items[0]?.state,
    workChainLength: graph.auditChain().length,
    logChainLength: log.length,
    authenticated: options.integritySecret !== undefined,
  };
}
