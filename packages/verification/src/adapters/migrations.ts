import { readFileSync } from "node:fs";

export interface VerificationMigration {
  readonly id: string;
  readonly sql: string;
}

export const VERIFICATION_MIGRATIONS: readonly VerificationMigration[] = [
  {
    id: "0001_verification",
    sql: readFileSync(
      new URL("../../migrations/0001_verification.sql", import.meta.url),
      "utf8",
    ),
  },
  {
    id: "0002_materialization",
    sql: readFileSync(
      new URL("../../migrations/0002_materialization.sql", import.meta.url),
      "utf8",
    ),
  },
  {
    id: "0003_builder_v1_binding",
    sql: readFileSync(
      new URL("../../migrations/0003_builder_v1_binding.sql", import.meta.url),
      "utf8",
    ),
  },
];
