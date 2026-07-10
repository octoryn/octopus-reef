import { createRequire } from "node:module";
import { MIGRATIONS } from "./migrations.js";
import type { GatewayDb } from "./db.js";
import type {
  AccountRecord,
  GatewayLedgerAnchor,
  LicenseRecord,
  QuotaRecord,
  StoredLedgerRecord,
  UsageRecord,
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

interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly password_salt: string;
  readonly password_hash: string;
  readonly status: AccountRecord["status"];
  readonly team_id: string | null;
  readonly created_at: string;
}

interface LicenseRow {
  readonly id: string;
  readonly account_id: string;
  readonly token_hash: string;
  readonly plan_id: string;
  readonly status: LicenseRecord["status"];
  readonly entitlements_json: string | object;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

interface QuotaRow {
  readonly account_id: string;
  readonly limit_tokens: number;
  readonly used_tokens: number;
  readonly updated_at: string;
}

interface SumRow {
  readonly total: string | number | null;
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

  async upsertAccount(account: AccountRecord): Promise<void> {
    await this.#pool.query(
      "INSERT INTO accounts (id, email, display_name, password_salt, password_hash, status, team_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) " +
        "ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, password_salt = excluded.password_salt, password_hash = excluded.password_hash, status = excluded.status, team_id = excluded.team_id",
      [
        account.id,
        account.email,
        account.displayName,
        account.passwordSalt,
        account.passwordHash,
        account.status,
        account.teamId ?? null,
        account.createdAt,
      ],
    );
  }

  async getAccount(accountId: string): Promise<AccountRecord | undefined> {
    const result = await this.#pool.query<AccountRow>(
      "SELECT id, email, display_name, password_salt, password_hash, status, team_id, created_at FROM accounts WHERE id = $1",
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : accountFromRow(row);
  }

  async getAccountByEmail(email: string): Promise<AccountRecord | undefined> {
    const result = await this.#pool.query<AccountRow>(
      "SELECT id, email, display_name, password_salt, password_hash, status, team_id, created_at FROM accounts WHERE email = $1",
      [email],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : accountFromRow(row);
  }

  async upsertLicense(license: LicenseRecord): Promise<void> {
    await this.#pool.query(
      "INSERT INTO licenses (id, account_id, token_hash, plan_id, status, entitlements_json, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) " +
        "ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, token_hash = excluded.token_hash, plan_id = excluded.plan_id, status = excluded.status, entitlements_json = excluded.entitlements_json, revoked_at = excluded.revoked_at",
      [
        license.id,
        license.accountId,
        license.tokenHash,
        license.planId,
        license.status,
        JSON.stringify(license.entitlements),
        license.createdAt,
        license.revokedAt ?? null,
      ],
    );
  }

  async getActiveLicenseByAccount(
    accountId: string,
  ): Promise<LicenseRecord | undefined> {
    const result = await this.#pool.query<LicenseRow>(
      "SELECT id, account_id, token_hash, plan_id, status, entitlements_json, created_at, revoked_at FROM licenses WHERE account_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : licenseFromRow(row);
  }

  async getLicenseByTokenHash(
    tokenHash: string,
  ): Promise<LicenseRecord | undefined> {
    const result = await this.#pool.query<LicenseRow>(
      "SELECT id, account_id, token_hash, plan_id, status, entitlements_json, created_at, revoked_at FROM licenses WHERE token_hash = $1 LIMIT 1",
      [tokenHash],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : licenseFromRow(row);
  }

  async revokeLicense(accountId: string, revokedAt: string): Promise<void> {
    await this.#pool.query(
      "UPDATE licenses SET status = 'revoked', revoked_at = $1 WHERE account_id = $2 AND status = 'active'",
      [revokedAt, accountId],
    );
  }

  async upsertQuota(quota: QuotaRecord): Promise<void> {
    await this.#pool.query(
      "INSERT INTO quotas (account_id, limit_tokens, used_tokens, updated_at) VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT(account_id) DO UPDATE SET limit_tokens = excluded.limit_tokens, used_tokens = excluded.used_tokens, updated_at = excluded.updated_at",
      [quota.accountId, quota.limitTokens, quota.usedTokens, quota.updatedAt],
    );
  }

  async getQuota(accountId: string): Promise<QuotaRecord | undefined> {
    const result = await this.#pool.query<QuotaRow>(
      "SELECT account_id, limit_tokens, used_tokens, updated_at FROM quotas WHERE account_id = $1",
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : quotaFromRow(row);
  }

  async debitQuota(
    accountId: string,
    tokens: number,
    updatedAt: string,
  ): Promise<void> {
    await this.#pool.query(
      "UPDATE quotas SET used_tokens = used_tokens + $1, updated_at = $2 WHERE account_id = $3",
      [tokens, updatedAt, accountId],
    );
  }

  async appendUsageRecord(record: UsageRecord): Promise<void> {
    await this.#pool.query(
      "INSERT INTO usage_records (id, account_id, request_id, model, input_tokens, output_tokens, total_tokens, cost_usd, evidence_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [
        record.id,
        record.accountId,
        record.requestId,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.totalTokens,
        record.costUsd,
        record.evidenceId,
        record.createdAt,
      ],
    );
  }

  async sumUsageForAccount(accountId: string): Promise<number> {
    const result = await this.#pool.query<SumRow>(
      "SELECT SUM(total_tokens) AS total FROM usage_records WHERE account_id = $1",
      [accountId],
    );
    const total = result.rows[0]?.total;
    return total === null || total === undefined ? 0 : Number(total);
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

function accountFromRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    status: row.status,
    ...(row.team_id !== null ? { teamId: row.team_id } : {}),
    createdAt: row.created_at,
  };
}

function licenseFromRow(row: LicenseRow): LicenseRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    tokenHash: row.token_hash,
    planId: row.plan_id,
    status: row.status,
    entitlements: parseJson(row.entitlements_json) as readonly string[],
    createdAt: row.created_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}

function quotaFromRow(row: QuotaRow): QuotaRecord {
  return {
    accountId: row.account_id,
    limitTokens: row.limit_tokens,
    usedTokens: row.used_tokens,
    updatedAt: row.updated_at,
  };
}
