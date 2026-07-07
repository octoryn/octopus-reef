/**
 * Action executors — the seam where an authorized action actually happens.
 *
 * The default {@link NoopExecutor} runs NOTHING (records intent only) — the safe
 * default, and what keeps `reef run` from touching the machine until a real
 * executor is wired. {@link WorkspaceExecutor} performs real file `read`/`edit`
 * confined to a workspace root; `command` execution is intentionally deferred to
 * the OS sandbox (M1b-3) — after the 2026-07-06 incident, no unsandboxed shell.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ActionRequest } from "./types.js";

/**
 * The workspace root, canonicalised: realpath the deepest EXISTING ancestor and
 * re-append any not-yet-created suffix. This lets the executor bootstrap a
 * missing root (the first `edit` creates it) instead of throwing an opaque
 * ENOENT, while still resolving symlinks in the real part of the root path.
 *
 * A symlink root is FOLLOWED to its intended target — even a dangling one — so a
 * root that is itself a broken/not-yet-created symlink still bootstraps rather
 * than false-rejecting every operation. The hop count defuses symlink cycles.
 */
function canonicalRoot(root: string): string {
  const missing: string[] = [];
  let probe = resolve(root);
  for (let hops = 0; hops < 64; hops++) {
    let stat;
    try {
      stat = lstatSync(probe);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break; // reached filesystem root; nothing exists
      missing.unshift(relative(parent, probe));
      probe = parent;
      continue;
    }
    if (stat.isSymbolicLink()) {
      probe = resolve(dirname(probe), readlinkSync(probe));
      continue;
    }
    const real = realpathSync(probe);
    return missing.length > 0 ? join(real, ...missing) : real;
  }
  return resolve(root);
}

export interface ExecOutcome {
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly exitCode?: number;
}

export interface ActionExecutor {
  readonly name: string;
  execute(action: ActionRequest): Promise<ExecOutcome>;
}

/** Executes nothing — records that the action was authorized but not run. */
export class NoopExecutor implements ActionExecutor {
  readonly name = "noop";
  execute(_action: ActionRequest): Promise<ExecOutcome> {
    return Promise.resolve({
      ok: true,
      output: "(authorized; not executed — no executor configured)",
    });
  }
}

const MAX_READ = 4000;

/** Real file `read`/`edit`, strictly confined to a workspace root. */
export class WorkspaceExecutor implements ActionExecutor {
  readonly name = "workspace";
  readonly #root: string;

  constructor(root: string) {
    this.#root = canonicalRoot(root);
  }

  /**
   * Resolve `target` inside the root, or throw if it escapes. Guards, in order:
   *   1. lexical — the resolved path must stay under the root;
   *   2. symlink — resolve every symlink in the path's EXISTING prefix and
   *      require the true location to stay under the root.
   *
   * The existing prefix is found with `lstat` (not `existsSync`), so a DANGLING
   * symlink counts as existing — otherwise `existsSync` follows it, reports it
   * missing, and a write follows it straight out of the root. A dangling link
   * can't be resolved (`realpath` throws) so it is rejected outright. A link
   * that resolves to a path still UNDER the root (e.g. `latest -> v1`) is
   * allowed — only links that resolve OUTSIDE the root escape.
   *
   * (A residual TOCTOU remains if a component is swapped between this check and
   * the fs call; for a local single-user tool that is out of scope — the real
   * isolation boundary is the OS sandbox, M1b-3.)
   */
  #confine(target: string): string {
    const p = resolve(this.#root, target);
    const rel = relative(this.#root, p);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path escapes the workspace: ${target}`);
    }
    // Deepest existing component (a dangling symlink lstat's fine, so it counts).
    let probe = p;
    for (;;) {
      try {
        lstatSync(probe);
        break;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    // Resolve symlinks in the existing prefix; a dangling link can't resolve.
    let real: string;
    try {
      real = realpathSync(probe);
    } catch {
      throw new Error(`path escapes the workspace via a symlink: ${target}`);
    }
    // True final location = resolved prefix + the not-yet-created tail.
    const resolved = probe === p ? real : join(real, relative(probe, p));
    const realRel = relative(this.#root, resolved);
    if (realRel !== "" && (realRel.startsWith("..") || isAbsolute(realRel))) {
      throw new Error(`path escapes the workspace via a symlink: ${target}`);
    }
    return p;
  }

  execute(action: ActionRequest): Promise<ExecOutcome> {
    try {
      if (action.type === "read") {
        const text = readFileSync(this.#confine(action.target ?? ""), "utf8");
        return Promise.resolve({
          ok: true,
          output: text.length > MAX_READ ? `${text.slice(0, MAX_READ)}…` : text,
        });
      }
      if (action.type === "edit") {
        const p = this.#confine(action.target ?? "");
        const content =
          action.payload &&
          typeof action.payload === "object" &&
          "content" in action.payload
            ? action.payload.content
            : undefined;
        if (typeof content !== "string") {
          return Promise.resolve({
            ok: false,
            error: "edit requires a string payload.content",
          });
        }
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        return Promise.resolve({
          ok: true,
          output: `wrote ${content.length} bytes to ${relative(this.#root, p)}`,
        });
      }
      return Promise.resolve({
        ok: false,
        error: `'${action.type}' execution is deferred to the OS sandbox (M1b-3)`,
      });
    } catch (err) {
      return Promise.resolve({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
