import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface ControlPlaneMigration {
  readonly id: string;
  readonly sql: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name: string): string =>
  readFileSync(resolve(here, `../../migrations/${name}.sql`), "utf8");

export const CONTROL_PLANE_MIGRATIONS: readonly ControlPlaneMigration[] = [
  {
    id: "0001_control_plane",
    sql: migration("0001_control_plane"),
  },
  {
    id: "0002_remote_contract",
    sql: migration("0002_remote_contract"),
  },
  {
    id: "0003_transactional_dispatch",
    sql: migration("0003_transactional_dispatch"),
  },
];
