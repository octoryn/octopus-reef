import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  LEGAL_TRANSITIONS,
  WorkStateGraph,
  type Actor,
  type StateTransition,
  type WorkItem,
  type WorkState,
} from "octopus-workstate";
import { loadJsonl, saveJsonl } from "octopus-workstate/storage/jsonl";

const SPEC_ACTOR: Actor = Object.freeze({
  id: "reef-spec-agent",
  kind: "agent",
  source: "reef",
  displayName: "Reef Spec Agent",
});

const WORK_FILE = "workstate.jsonl";
const META_FILE = "spec.json";
const DEFAULT_TASKS = [
  "Clarify requirements",
  "Design governed change",
  "Implement and verify",
];
const WORK_STATES = new Set<WorkState>(
  Object.keys(LEGAL_TRANSITIONS) as WorkState[],
);

export interface CreateSpecRequest {
  readonly title?: unknown;
  readonly tasks?: unknown;
}

export interface AdvanceSpecRequest {
  readonly itemId?: unknown;
  readonly to?: unknown;
  readonly reason?: unknown;
}

export interface SpecSummary {
  readonly id: string;
  readonly title: string;
  readonly taskCount: number;
  readonly states: Readonly<Record<WorkState, number>>;
  readonly anchor: {
    readonly length: number;
    readonly head: string;
  };
  readonly verify: SpecVerifyResult;
  readonly updatedAt: string;
}

export interface SpecTaskView {
  readonly id: string;
  readonly title: string;
  readonly state: WorkState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly assignee?: Actor;
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly kind: string;
  }[];
  readonly history: readonly SpecTransitionView[];
}

export interface SpecTransitionView {
  readonly itemId: string;
  readonly from: WorkState | null;
  readonly to: WorkState;
  readonly by: Actor;
  readonly at: string;
  readonly evidenceId: string;
  readonly sequence: number;
  readonly reason?: string;
}

export interface SpecVerifyResult {
  readonly ok: boolean;
  readonly work: string;
  readonly anchor?: {
    readonly length: number;
    readonly head: string;
  };
}

export interface SpecView {
  readonly id: string;
  readonly title: string;
  readonly tasks: readonly SpecTaskView[];
  readonly transitions: readonly SpecTransitionView[];
  readonly dependencies: readonly {
    readonly from: string;
    readonly to: string;
    readonly kind: string;
  }[];
  readonly anchor: {
    readonly length: number;
    readonly head: string;
  };
  readonly verify: SpecVerifyResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdvanceSpecResult {
  readonly transition: SpecTransitionView;
  readonly spec: SpecView;
}

interface SpecRecord {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly graph?: WorkStateGraph;
}

interface StoredSpecMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class SpecRegistry {
  readonly #root: string | undefined;
  readonly #specs = new Map<string, SpecRecord>();
  #counter = 0;

  constructor(persistDir?: string) {
    this.#root = persistDir === undefined ? undefined : join(persistDir, "specs");
    if (this.#root !== undefined) this.#loadPersisted();
  }

  list(): { readonly specs: readonly SpecSummary[] } {
    return {
      specs: [...this.#specs.values()].map((spec) =>
        this.#summary(spec, this.#loadGraph(spec)),
      ),
    };
  }

  create(input: CreateSpecRequest = {}): SpecView {
    const now = new Date().toISOString();
    const title = optionalString(input.title) ?? "Untitled Reef Spec";
    const tasks = normalizeTasks(input.tasks);
    const id = `spec-${(this.#counter++).toString(36)}-${Date.now().toString(36)}`;
    const graph = new WorkStateGraph();
    for (let i = 0; i < tasks.length; i++) {
      graph.add({
        id: `${id}-task-${i + 1}`,
        title: tasks[i]!,
        origin: {
          originType: "manual",
          note: `seeded by Reef Spec ${title}`,
        },
      });
    }
    const record: SpecRecord = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      ...(this.#root === undefined ? { graph } : {}),
    };
    this.#specs.set(id, record);
    this.#save(record, graph);
    return this.#view(record, graph);
  }

  get(id: string): SpecView {
    const record = this.#require(id);
    return this.#view(record, this.#loadGraph(record));
  }

  verify(id: string): SpecVerifyResult {
    const record = this.#require(id);
    try {
      const graph = this.#loadGraph(record);
      const check = graph.verify();
      const anchor = graph.anchor();
      return check.ok
        ? { ok: true, work: "intact", anchor }
        : {
            ok: false,
            work: `broken: ${check.reason} (at ${String(check.brokenAt)})`,
            anchor,
          };
    } catch (err) {
      return {
        ok: false,
        work: `broken: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  advance(id: string, input: AdvanceSpecRequest): AdvanceSpecResult {
    const record = this.#require(id);
    const graph = this.#loadGraph(record);
    const itemId = optionalString(input.itemId);
    if (itemId === undefined) throw new Error("itemId is required");
    const to = workState(input.to);
    const reason =
      optionalString(input.reason) ?? `Reef advanced ${itemId} to ${to}`;
    const transition = graph.transition(itemId, to, {
      by: SPEC_ACTOR,
      reason,
    });
    record.updatedAt = transition.at;
    this.#save(record, graph);
    return {
      transition: transitionView(transition),
      spec: this.#view(record, graph),
    };
  }

  #loadPersisted(): void {
    mkdirSync(this.#root!, { recursive: true });
    for (const entry of readdirSync(this.#root!)) {
      const dir = join(this.#root!, entry);
      if (!statSync(dir).isDirectory()) continue;
      const metaPath = join(dir, META_FILE);
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as StoredSpecMeta;
        if (typeof meta.id !== "string" || typeof meta.title !== "string") {
          continue;
        }
        this.#specs.set(meta.id, {
          id: meta.id,
          title: meta.title,
          createdAt:
            typeof meta.createdAt === "string"
              ? meta.createdAt
              : new Date(0).toISOString(),
          updatedAt:
            typeof meta.updatedAt === "string"
              ? meta.updatedAt
              : new Date(0).toISOString(),
        });
      } catch {
        /* ignore unreadable metadata; the workstate file remains untouched */
      }
    }
    this.#counter = this.#specs.size;
  }

  #require(id: string): SpecRecord {
    const spec = this.#specs.get(id);
    if (spec === undefined) throw new Error(`unknown spec: ${id}`);
    return spec;
  }

  #dir(record: SpecRecord): string {
    if (this.#root === undefined) throw new Error("specs are not persisted");
    return join(this.#root, record.id);
  }

  #loadGraph(record: SpecRecord): WorkStateGraph {
    if (this.#root === undefined) {
      if (record.graph === undefined) throw new Error("spec graph is missing");
      return record.graph;
    }
    return loadJsonl(join(this.#dir(record), WORK_FILE));
  }

  #save(record: SpecRecord, graph: WorkStateGraph): void {
    if (this.#root === undefined) return;
    const dir = this.#dir(record);
    mkdirSync(dir, { recursive: true });
    saveJsonl(graph, join(dir, WORK_FILE));
    const meta: StoredSpecMeta = {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    atomicWrite(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  }

  #summary(record: SpecRecord, graph: WorkStateGraph): SpecSummary {
    const states = Object.fromEntries(
      [...WORK_STATES].map((state) => [state, 0]),
    ) as Record<WorkState, number>;
    for (const item of graph.items()) states[item.state]++;
    return {
      id: record.id,
      title: record.title,
      taskCount: graph.items().length,
      states,
      anchor: graph.anchor(),
      verify: this.verify(record.id),
      updatedAt: record.updatedAt,
    };
  }

  #view(record: SpecRecord, graph: WorkStateGraph): SpecView {
    const transitions = graph.transitions().map(transitionView);
    return {
      id: record.id,
      title: record.title,
      tasks: graph.items().map((item) => taskView(item, graph)),
      transitions,
      dependencies: graph.dependencies(),
      anchor: graph.anchor(),
      verify: this.verify(record.id),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

function transitionView(transition: StateTransition): SpecTransitionView {
  return {
    itemId: transition.itemId,
    from: transition.from,
    to: transition.to,
    by: transition.by,
    at: transition.at,
    evidenceId: transition.evidenceId,
    sequence: transition.sequence,
    ...(transition.reason !== undefined ? { reason: transition.reason } : {}),
  };
}

function taskView(item: WorkItem, graph: WorkStateGraph): SpecTaskView {
  return {
    id: item.id,
    title: item.title,
    state: item.state,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.assignee !== undefined ? { assignee: item.assignee } : {}),
    evidence: item.evidence,
    history: graph.history(item.id).map(transitionView),
  };
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function normalizeTasks(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return DEFAULT_TASKS;
  const tasks = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry !== "");
  if (tasks.length === 0) throw new Error("at least one task is required");
  return tasks;
}

function workState(value: unknown): WorkState {
  const state = optionalString(value);
  if (state === undefined || !WORK_STATES.has(state as WorkState)) {
    throw new Error(`invalid work state: ${String(value)}`);
  }
  return state as WorkState;
}
