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
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ActionRequest } from "./types.js";

/**
 * The workspace root, canonicalised: realpath the deepest EXISTING ancestor and
 * re-append any not-yet-created suffix. This lets the executor bootstrap a
 * missing root (the first `edit` creates it) instead of throwing an opaque
 * ENOENT, while still resolving symlinks in the real part of the root path.
 */
function canonicalRoot(root: string): string {
  const abs = resolve(root);
  const missing: string[] = [];
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      return missing.length > 0 ? join(real, ...missing) : real;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return abs; // nothing on this path exists
      missing.unshift(relative(parent, probe));
      probe = parent;
    }
  }
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
   * Resolve `target` inside the root, or throw if it escapes. Two independent
   * guards: (1) a lexical check that the resolved path stays under the root, and
   * (2) a symlink check — every EXISTING path component is `lstat`'d (which does
   * NOT follow links) and ANY symlink component is rejected.
   *
   * Rejecting symlinks outright (rather than resolving them) is what closes the
   * dangling-symlink hole: a link whose target does not exist yet is still an
   * `lstat` symlink, even though `existsSync` reports it missing and a naive
   * ancestor walk would climb straight past it and let the write follow it out.
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
    let cur = this.#root;
    for (const part of rel.split(sep)) {
      if (part === "") continue;
      cur = join(cur, part);
      let stat;
      try {
        stat = lstatSync(cur);
      } catch {
        break; // this component doesn't exist yet — nothing below it can either
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`path escapes the workspace via a symlink: ${target}`);
      }
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
