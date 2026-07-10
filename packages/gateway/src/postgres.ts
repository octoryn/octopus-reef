import { createRequire } from "node:module";
import { MIGRATIONS } from "./migrations.js";
import type { GatewayDb } from "./db.js";
import type {
  GatewayLedgerAnchor,
  StoredLedgerRecord,
} from "./types.js";

interface PgQueryResult<Row> {
  readonly rows: Row[];
}

interface PgPool {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>;
  end(): Promise<void>;
}

type PgPoolCtor = new (options: { connectionString: string }) => PgPool;

interface LedgerRow {
  readonly sequence: number;
  readonly evidence_json: string | object;
  readonly link_json: string | object;
  readonly created_at: string;
}

interface MetaRow {
  readonly value: string;
}

export class PostgresGatewayDb implements GatewayDb {
  readonly #pool: PgPool;

  constructor(connectionString: string) {
    const Pool = loadPgPool();
    this.#pool = new Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    await this.#pool.query("BEGIN");
    try {
      for (const migration of MIGRATIONS) {
        await this.#pool.query(migration.sql);
        await this.#pool.query(
          "INSERT INTO gateway_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO NOTHING",
          [`migration:${migration.id}`, new Date(0).toISOString()],
        );
      }
      await this.#pool.query("COMMIT");
    } catch (error) {
      await this.#pool.query("ROLLBACK");
      throw error;
    }
  }

  async appendLedgerRecord(record: StoredLedgerRecord): Promise<void> {
    await this.#pool.query(
      "INSERT INTO gateway_ledger (sequence, evidence_json, link_json, created_at) VALUES ($1, $2, $3, $4)",
      [
        record.sequence,
        JSON.stringify(record.evidence),
        JSON.stringify(record.link),
        record.createdAt,
      ],
    );
  }

  async listLedgerRecords(): Promise<readonly StoredLedgerRecord[]> {
    const result = await this.#pool.query<LedgerRow>(
      "SELECT sequence, evidence_json, link_json, created_at FROM gateway_ledger ORDER BY sequence ASC",
    );
    return result.rows.map((row) => ({
      sequence: row.sequence,
      evidence: parseJson(row.evidence_json) as StoredLedgerRecord["evidence"],
      link: parseJson(row.link_json) as StoredLedgerRecord["link"],
      createdAt: row.created_at,
    }));
  }

  async readLedgerAnchor(): Promise<GatewayLedgerAnchor | undefined> {
    const result = await this.#pool.query<MetaRow>(
      "SELECT value FROM gateway_meta WHERE key = $1",
      ["gateway-ledger-anchor"],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : (JSON.parse(row.value) as GatewayLedgerAnchor);
  }

  async writeLedgerAnchor(anchor: GatewayLedgerAnchor): Promise<void> {
    await this.#pool.query(
      "INSERT INTO gateway_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ["gateway-ledger-anchor", JSON.stringify(anchor)],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

function loadPgPool(): PgPoolCtor {
  const require = createRequire(import.meta.url);
  return (require("pg") as { Pool: PgPoolCtor }).Pool;
}

function parseJson(value: string | object): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
