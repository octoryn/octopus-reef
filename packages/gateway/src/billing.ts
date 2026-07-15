import { randomUUID } from "node:crypto";
import type { GatewayDb } from "./db.js";
import type { BillingRecord, GatewayConfig, UsageRecord } from "./types.js";

export interface BillingAdapter {
  readonly name: "local-ledger" | "stripe";
  recordUsage(record: UsageRecord): Promise<BillingRecord>;
}

export class LocalLedgerBillingAdapter implements BillingAdapter {
  readonly name = "local-ledger" as const;
  readonly #db: GatewayDb;

  constructor(db: GatewayDb) {
    this.#db = db;
  }

  async recordUsage(record: UsageRecord): Promise<BillingRecord> {
    const billing: BillingRecord = {
      id: randomUUID(),
      accountId: record.accountId,
      usageRecordId: record.id,
      amountUsd: record.costUsd,
      currency: "usd",
      provider: this.name,
      status: "recorded",
      createdAt: new Date().toISOString(),
    };
    await this.#db.appendBillingRecord(billing);
    return billing;
  }
}

export class StripeBillingAdapter implements BillingAdapter {
  readonly name = "stripe" as const;

  constructor(readonly apiKeyConfigured: boolean) {}

  recordUsage(_record: UsageRecord): Promise<BillingRecord> {
    throw new Error(
      "Stripe billing adapter is intentionally stubbed until a real Stripe integration is supplied",
    );
  }
}

export function createBillingAdapter(
  config: GatewayConfig,
  db: GatewayDb,
): BillingAdapter {
  return config.stripeApiKey === undefined
    ? new LocalLedgerBillingAdapter(db)
    : new StripeBillingAdapter(true);
}
