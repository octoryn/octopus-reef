import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { MIGRATIONS } from "./migrations.js";
import type { GatewayDb } from "./db.js";
import type {
  AccountRecord,
  BillingRecord,
  GatewayLedgerAnchor,
  LicenseRecord,
  QuotaRecord,
  StoredLedgerRecord,
  UsageRecord,
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
  readonly entitlements_json: string;
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
  readonly total: number | null;
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

  async upsertAccount(account: AccountRecord): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO accounts (id, email, display_name, password_salt, password_hash, status, team_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, password_salt = excluded.password_salt, password_hash = excluded.password_hash, status = excluded.status, team_id = excluded.team_id",
      )
      .run(
        account.id,
        account.email,
        account.displayName,
        account.passwordSalt,
        account.passwordHash,
        account.status,
        account.teamId ?? null,
        account.createdAt,
      );
  }

  async getAccount(accountId: string): Promise<AccountRecord | undefined> {
    const row = this.#db
      .prepare(
        "SELECT id, email, display_name, password_salt, password_hash, status, team_id, created_at FROM accounts WHERE id = ?",
      )
      .get(accountId) as AccountRow | undefined;
    return row === undefined ? undefined : accountFromRow(row);
  }

  async getAccountByEmail(email: string): Promise<AccountRecord | undefined> {
    const row = this.#db
      .prepare(
        "SELECT id, email, display_name, password_salt, password_hash, status, team_id, created_at FROM accounts WHERE email = ?",
      )
      .get(email) as AccountRow | undefined;
    return row === undefined ? undefined : accountFromRow(row);
  }

  async upsertLicense(license: LicenseRecord): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO licenses (id, account_id, token_hash, plan_id, status, entitlements_json, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, token_hash = excluded.token_hash, plan_id = excluded.plan_id, status = excluded.status, entitlements_json = excluded.entitlements_json, revoked_at = excluded.revoked_at",
      )
      .run(
        license.id,
        license.accountId,
        license.tokenHash,
        license.planId,
        license.status,
        JSON.stringify(license.entitlements),
        license.createdAt,
        license.revokedAt ?? null,
      );
  }

  async getActiveLicenseByAccount(
    accountId: string,
  ): Promise<LicenseRecord | undefined> {
    const row = this.#db
      .prepare(
        "SELECT id, account_id, token_hash, plan_id, status, entitlements_json, created_at, revoked_at FROM licenses WHERE account_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      )
      .get(accountId) as LicenseRow | undefined;
    return row === undefined ? undefined : licenseFromRow(row);
  }

  async getLicenseByTokenHash(
    tokenHash: string,
  ): Promise<LicenseRecord | undefined> {
    const row = this.#db
      .prepare(
        "SELECT id, account_id, token_hash, plan_id, status, entitlements_json, created_at, revoked_at FROM licenses WHERE token_hash = ? LIMIT 1",
      )
      .get(tokenHash) as LicenseRow | undefined;
    return row === undefined ? undefined : licenseFromRow(row);
  }

  async revokeLicense(accountId: string, revokedAt: string): Promise<void> {
    this.#db
      .prepare(
        "UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE account_id = ? AND status = 'active'",
      )
      .run(revokedAt, accountId);
  }

  async upsertQuota(quota: QuotaRecord): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO quotas (account_id, limit_tokens, used_tokens, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(account_id) DO UPDATE SET limit_tokens = excluded.limit_tokens, used_tokens = excluded.used_tokens, updated_at = excluded.updated_at",
      )
      .run(quota.accountId, quota.limitTokens, quota.usedTokens, quota.updatedAt);
  }

  async getQuota(accountId: string): Promise<QuotaRecord | undefined> {
    const row = this.#db
      .prepare(
        "SELECT account_id, limit_tokens, used_tokens, updated_at FROM quotas WHERE account_id = ?",
      )
      .get(accountId) as QuotaRow | undefined;
    return row === undefined ? undefined : quotaFromRow(row);
  }

  async debitQuota(
    accountId: string,
    tokens: number,
    updatedAt: string,
  ): Promise<void> {
    this.#db
      .prepare(
        "UPDATE quotas SET used_tokens = used_tokens + ?, updated_at = ? WHERE account_id = ?",
      )
      .run(tokens, updatedAt, accountId);
  }

  async appendUsageRecord(record: UsageRecord): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO usage_records (id, account_id, request_id, model, input_tokens, output_tokens, total_tokens, cost_usd, evidence_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
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
      );
  }

  async sumUsageForAccount(accountId: string): Promise<number> {
    const row = this.#db
      .prepare("SELECT SUM(total_tokens) AS total FROM usage_records WHERE account_id = ?")
      .get(accountId) as SumRow | undefined;
    return row?.total ?? 0;
  }

  async sumCostForAccount(accountId: string): Promise<number> {
    const row = this.#db
      .prepare("SELECT SUM(cost_usd) AS total FROM usage_records WHERE account_id = ?")
      .get(accountId) as SumRow | undefined;
    return row?.total ?? 0;
  }

  async appendBillingRecord(record: BillingRecord): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO billing_records (id, account_id, usage_record_id, amount_usd, currency, provider, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.accountId,
        record.usageRecordId,
        record.amountUsd,
        record.currency,
        record.provider,
        record.status,
        record.createdAt,
      );
  }

  async sumBillingForAccount(accountId: string): Promise<number> {
    const row = this.#db
      .prepare("SELECT SUM(amount_usd) AS total FROM billing_records WHERE account_id = ?")
      .get(accountId) as SumRow | undefined;
    return row?.total ?? 0;
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
    entitlements: JSON.parse(row.entitlements_json) as readonly string[],
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
