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
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ActionRequest } from "./types.js";

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
    this.#root = resolve(root);
  }

  /**
   * Resolve `target` inside the root, or throw if it escapes — lexically AND via
   * symlinks. A purely lexical check is not enough: `readFileSync`/`writeFileSync`
   * follow symlinks, so a symlink inside the root (final target OR an intermediate
   * directory component) can point outside. We realpath the deepest EXISTING
   * ancestor and require it to stay within the realpath'd root, which catches both
   * a symlinked target and a symlinked parent, for read and write alike.
   *
   * (A residual TOCTOU exists if a symlink is swapped between this check and the
   * fs call; for a local single-user tool that is out of scope — the real
   * isolation boundary is the OS sandbox, M1b-3.)
   */
  #confine(target: string): string {
    const p = resolve(this.#root, target);
    const rel = relative(this.#root, p);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path escapes the workspace: ${target}`);
    }
    const realRoot = realpathSync(this.#root);
    let probe = p;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realRel = relative(realRoot, realpathSync(probe));
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
