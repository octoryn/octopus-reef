import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  AddCustomSteeringRequest,
  SetSteeringActiveRequest,
  SteeringItemKind,
  SteeringItemView,
  SteeringListResponse,
} from "@octopus-reef/protocol";

interface StoredSteering {
  readonly custom?: readonly StoredSteeringItem[];
  readonly activeIds?: readonly string[];
}

interface StoredSteeringItem {
  readonly id: string;
  readonly title: string;
  readonly kind: SteeringItemKind;
  readonly content: string;
  readonly mockEffect?: string;
  readonly updatedAt: string;
}

const BUILT_IN_UPDATED = "2026-07-09T00:00:00.000Z";

const BUILT_INS: readonly StoredSteeringItem[] = [
  {
    id: "architecture-selection",
    title: "Architecture Selection",
    kind: "doc",
    content:
      "Prefer existing Reef ownership boundaries, keep governance in the engine/server, and keep surfaces thin.",
    mockEffect:
      "N3 steering applied: chose the smallest engine/server-owned design.",
    updatedAt: BUILT_IN_UPDATED,
  },
  {
    id: "quick-spec",
    title: "Quick Spec",
    kind: "doc",
    content:
      "Before implementation, restate the goal as work items and make every state transition evidence-backed.",
    mockEffect:
      "N3 steering applied: produced a workstate-shaped quick spec.",
    updatedAt: BUILT_IN_UPDATED,
  },
  {
    id: "bug-fix",
    title: "Bug Fix",
    kind: "skill",
    content:
      "Reproduce the failure first, make the narrowest fix, then prove it with the focused test.",
    mockEffect:
      "N3 steering applied: followed the bug-fix skill before editing.",
    updatedAt: BUILT_IN_UPDATED,
  },
];

export class SteeringRegistry {
  readonly #storePath: string | undefined;
  #custom: StoredSteeringItem[] = [];
  #activeIds: string[] = [];

  constructor(persistDir: string | undefined) {
    this.#storePath =
      persistDir === undefined ? undefined : join(persistDir, "steering.json");
    this.#load();
  }

  list(): SteeringListResponse {
    const available = this.#available();
    const active = this.activeItems();
    return {
      available,
      activeIds: this.#activeIds.filter((id) =>
        available.some((item) => item.id === id),
      ),
      active,
    };
  }

  addCustom(request: AddCustomSteeringRequest): SteeringItemView {
    const title = stringValue(request.title) ?? "Custom Steering";
    const content = stringValue(request.content);
    if (content === undefined) throw new Error("content is required");
    const kind = request.kind === "skill" ? "skill" : "doc";
    const id = `custom-${this.#custom.length.toString(36)}-${hash(content).slice(0, 10)}`;
    const mockEffect = stringValue(request.mockEffect);
    const item: StoredSteeringItem = {
      id,
      title,
      kind,
      content,
      ...(mockEffect !== undefined ? { mockEffect } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.#custom.push(item);
    this.#save();
    return view(item, "custom");
  }

  setActive(request: SetSteeringActiveRequest): SteeringListResponse {
    const available = new Set(this.#available().map((item) => item.id));
    const rawIds = Array.isArray(request.activeIds) ? request.activeIds : [];
    const ids: string[] = [];
    for (const raw of rawIds) {
      if (typeof raw !== "string") continue;
      const id = raw.trim();
      if (id === "") continue;
      if (!available.has(id)) throw new Error(`unknown steering item: ${id}`);
      if (!ids.includes(id)) ids.push(id);
    }
    this.#activeIds = ids;
    this.#save();
    return this.list();
  }

  activeItems(ids?: readonly string[]): readonly SteeringItemView[] {
    const wanted =
      ids === undefined
        ? this.#activeIds
        : ids.filter((id): id is string => typeof id === "string");
    const available = new Map(this.#available().map((item) => [item.id, item]));
    return wanted.flatMap((id) => {
      const item = available.get(id);
      return item === undefined ? [] : [item];
    });
  }

  #available(): readonly SteeringItemView[] {
    return [
      ...BUILT_INS.map((item) => view(item, "built-in")),
      ...this.#custom.map((item) => view(item, "custom")),
    ];
  }

  #load(): void {
    if (this.#storePath === undefined || !existsSync(this.#storePath)) return;
    try {
      const stored = JSON.parse(readFileSync(this.#storePath, "utf8")) as
        | StoredSteering
        | undefined;
      this.#custom = Array.isArray(stored?.custom)
        ? stored.custom.filter(isStoredItem)
        : [];
      this.#activeIds = Array.isArray(stored?.activeIds)
        ? stored.activeIds.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      this.#custom = [];
      this.#activeIds = [];
    }
  }

  #save(): void {
    if (this.#storePath === undefined) return;
    mkdirSync(dirname(this.#storePath), { recursive: true });
    const stored: StoredSteering = {
      custom: this.#custom,
      activeIds: this.#activeIds,
    };
    writeFileSync(this.#storePath, `${JSON.stringify(stored, null, 2)}\n`);
  }
}

function view(
  item: StoredSteeringItem,
  source: "built-in" | "custom",
): SteeringItemView {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    content: item.content,
    contentSha256: hash(item.content),
    source,
    ...(item.mockEffect !== undefined ? { mockEffect: item.mockEffect } : {}),
    updatedAt: item.updatedAt,
  };
}

function isStoredItem(value: unknown): value is StoredSteeringItem {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    (item.kind === "doc" || item.kind === "skill") &&
    typeof item.content === "string" &&
    typeof item.updatedAt === "string"
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}
