import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface ControlPlaneMigration {
  readonly id: string;
  readonly sql: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  here,
  process.env.NODE_ENV === "test" || here.endsWith("/src/adapters")
    ? "../../migrations/0001_control_plane.sql"
    : "../../migrations/0001_control_plane.sql",
);

export const CONTROL_PLANE_MIGRATIONS: readonly ControlPlaneMigration[] = [
  {
    id: "0001_control_plane",
    sql: readFileSync(migrationPath, "utf8"),
  },
];
