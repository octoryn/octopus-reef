import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  CreateHookRequest,
  FireHookRequest,
  HookDefinitionView,
  HookListResponse,
  HookTrigger,
} from "@octopus-reef/protocol";

interface StoredHooks {
  readonly hooks?: readonly HookDefinitionView[];
}

export class HookRegistry {
  readonly #storePath: string | undefined;
  #hooks: HookDefinitionView[] = [];

  constructor(persistDir: string | undefined) {
    this.#storePath =
      persistDir === undefined ? undefined : join(persistDir, "hooks.json");
    this.#load();
  }

  list(): HookListResponse {
    return { hooks: [...this.#hooks] };
  }

  create(request: CreateHookRequest): HookDefinitionView {
    const now = new Date().toISOString();
    const name = stringValue(request.name) ?? "On-Demand Reef Hook";
    const trigger = request.trigger === "on-save" ? "on-save" : "on-demand";
    const task =
      stringValue(request.task) ??
      (trigger === "on-save"
        ? "N4 on-save hook governed mock session"
        : "N4 on-demand hook governed mock session");
    const hook: HookDefinitionView = {
      id: `hook-${this.#hooks.length.toString(36)}-${Date.now().toString(36)}`,
      name,
      trigger,
      task,
      enabled: request.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    this.#hooks.push(hook);
    this.#save();
    return hook;
  }

  get(id: string): HookDefinitionView {
    const hook = this.#hooks.find((candidate) => candidate.id === id);
    if (hook === undefined) throw new Error(`unknown hook: ${id}`);
    return hook;
  }

  fire(
    id: string,
    request: FireHookRequest,
  ): {
    readonly hook: HookDefinitionView;
    readonly event: Readonly<Record<string, unknown>>;
  } {
    const hook = this.get(id);
    if (!hook.enabled) throw new Error(`hook is disabled: ${id}`);
    return {
      hook,
      event:
        request.event !== undefined && isObject(request.event)
          ? request.event
          : {},
    };
  }

  #load(): void {
    if (this.#storePath === undefined || !existsSync(this.#storePath)) return;
    try {
      const stored = JSON.parse(readFileSync(this.#storePath, "utf8")) as
        | StoredHooks
        | undefined;
      this.#hooks = Array.isArray(stored?.hooks)
        ? stored.hooks.filter(isHook)
        : [];
    } catch {
      this.#hooks = [];
    }
  }

  #save(): void {
    if (this.#storePath === undefined) return;
    mkdirSync(dirname(this.#storePath), { recursive: true });
    writeFileSync(
      this.#storePath,
      `${JSON.stringify({ hooks: this.#hooks }, null, 2)}\n`,
    );
  }
}

function isHook(value: unknown): value is HookDefinitionView {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.trigger === "on-demand" || value.trigger === "on-save") &&
    typeof value.task === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}
