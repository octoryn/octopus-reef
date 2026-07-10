import type {
  AccountRecord,
  BillingRecord,
  GatewayLedgerAnchor,
  LicenseRecord,
  QuotaRecord,
  StoredLedgerRecord,
  TeamMemberRecord,
  TeamRecord,
  UsageRecord,
} from "./types.js";

export interface GatewayDb {
  migrate(): Promise<void>;
  appendLedgerRecord(record: StoredLedgerRecord): Promise<void>;
  listLedgerRecords(): Promise<readonly StoredLedgerRecord[]>;
  readLedgerAnchor(): Promise<GatewayLedgerAnchor | undefined>;
  writeLedgerAnchor(anchor: GatewayLedgerAnchor): Promise<void>;
  upsertAccount(account: AccountRecord): Promise<void>;
  getAccount(accountId: string): Promise<AccountRecord | undefined>;
  getAccountByEmail(email: string): Promise<AccountRecord | undefined>;
  upsertLicense(license: LicenseRecord): Promise<void>;
  getActiveLicenseByAccount(accountId: string): Promise<LicenseRecord | undefined>;
  getLicenseByTokenHash(tokenHash: string): Promise<LicenseRecord | undefined>;
  revokeLicense(accountId: string, revokedAt: string): Promise<void>;
  upsertQuota(quota: QuotaRecord): Promise<void>;
  getQuota(accountId: string): Promise<QuotaRecord | undefined>;
  debitQuota(accountId: string, tokens: number, updatedAt: string): Promise<void>;
  appendUsageRecord(record: UsageRecord): Promise<void>;
  sumUsageForAccount(accountId: string): Promise<number>;
  sumCostForAccount(accountId: string): Promise<number>;
  appendBillingRecord(record: BillingRecord): Promise<void>;
  sumBillingForAccount(accountId: string): Promise<number>;
  upsertTeam(team: TeamRecord): Promise<void>;
  upsertTeamMember(member: {
    readonly teamId: string;
    readonly accountId: string;
    readonly role: TeamMemberRecord["role"];
    readonly createdAt: string;
  }): Promise<void>;
  getTeamForAccount(accountId: string): Promise<
    | {
        readonly team: TeamRecord;
        readonly member: TeamMemberRecord;
      }
    | undefined
  >;
  listTeamMembers(teamId: string): Promise<readonly TeamMemberRecord[]>;
  close(): Promise<void>;
}
