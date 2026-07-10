import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { MIGRATIONS } from "./migrations.js";
import type { GatewayDb } from "./db.js";
import type {
  GatewayLedgerAnchor,
  StoredLedgerRecord,
} from "./types.js";

interface SqliteStatement {
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): unknown[];
  run(...params: readonly unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteDatabaseCtor = new (location: string) => SqliteDatabase;

interface LedgerRow {
  readonly sequence: number;
  readonly evidence_json: string;
  readonly link_json: string;
  readonly created_at: string;
}

interface MetaRow {
  readonly value: string;
}

export class SqliteGatewayDb implements GatewayDb {
  readonly #db: SqliteDatabase;

  constructor(location: string) {
    if (location !== ":memory:") {
      mkdirSync(dirname(resolve(location)), { recursive: true });
    }
    const DatabaseSync = loadDatabaseSync();
    this.#db = new DatabaseSync(location);
    if (location !== ":memory:") {
      this.#db.exec("PRAGMA journal_mode = WAL;");
    }
  }

  async migrate(): Promise<void> {
    this.#db.exec("BEGIN");
    try {
      for (const migration of MIGRATIONS) {
        this.#db.exec(migration.sql);
        this.#db
          .prepare("INSERT OR IGNORE INTO gateway_meta (key, value) VALUES (?, ?)")
          .run(`migration:${migration.id}`, new Date(0).toISOString());
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async appendLedgerRecord(record: StoredLedgerRecord): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO gateway_ledger (sequence, evidence_json, link_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        record.sequence,
        JSON.stringify(record.evidence),
        JSON.stringify(record.link),
        record.createdAt,
      );
  }

  async listLedgerRecords(): Promise<readonly StoredLedgerRecord[]> {
    const rows = this.#db
      .prepare(
        "SELECT sequence, evidence_json, link_json, created_at FROM gateway_ledger ORDER BY sequence ASC",
      )
      .all() as LedgerRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      evidence: JSON.parse(row.evidence_json) as StoredLedgerRecord["evidence"],
      link: JSON.parse(row.link_json) as StoredLedgerRecord["link"],
      createdAt: row.created_at,
    }));
  }

  async readLedgerAnchor(): Promise<GatewayLedgerAnchor | undefined> {
    const row = this.#db
      .prepare("SELECT value FROM gateway_meta WHERE key = ?")
      .get("gateway-ledger-anchor") as MetaRow | undefined;
    if (row === undefined) return undefined;
    return JSON.parse(row.value) as GatewayLedgerAnchor;
  }

  async writeLedgerAnchor(anchor: GatewayLedgerAnchor): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO gateway_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run("gateway-ledger-anchor", JSON.stringify(anchor));
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  tamperLedgerEvidenceForTests(sequence: number, search: string, replace: string): void {
    const row = this.#db
      .prepare("SELECT evidence_json FROM gateway_ledger WHERE sequence = ?")
      .get(sequence) as { evidence_json: string } | undefined;
    if (row === undefined) throw new Error(`no ledger record ${sequence}`);
    const tampered = row.evidence_json.replace(search, replace);
    if (tampered === row.evidence_json) {
      throw new Error(`ledger record ${sequence} did not contain ${search}`);
    }
    this.#db
      .prepare("UPDATE gateway_ledger SET evidence_json = ? WHERE sequence = ?")
      .run(tampered, sequence);
  }
}

function loadDatabaseSync(): SqliteDatabaseCtor {
  const require = createRequire(import.meta.url);
  return (require("node:sqlite") as { DatabaseSync: SqliteDatabaseCtor })
    .DatabaseSync;
}
