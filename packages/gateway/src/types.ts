import type { ChainLink, Evidence, JsonValue } from "octopus-evidence";
import type { CompletionRequest, CompletionResponse, ModelUsage } from "@octopus-reef/agent";

export type DbDriver = "sqlite" | "postgres";

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly dbUrl: string;
  readonly ledgerSecret?: string;
  readonly jwtSecret: string;
  readonly jwtSecretSource: "env" | "ephemeral-local";
  readonly adminToken?: string;
  readonly rateLimitWindowMs: number;
  readonly rateLimitRequests: number;
  readonly defaultQuotaTokens: number;
  readonly tokenTtlSeconds: number;
  readonly localPricePerThousandTokens: number;
  readonly bedrockModel?: string;
  readonly awsRegion: string;
  readonly oidcIssuer?: string;
  readonly oidcClientId: string;
  readonly oidcRedirectUri: string;
  readonly stripeApiKey?: string;
}

export interface GatewayLedgerAnchor {
  readonly head: string;
  readonly length: number;
  readonly updatedAt: string;
}

export interface StoredLedgerRecord {
  readonly sequence: number;
  readonly evidence: Evidence;
  readonly link: ChainLink;
  readonly createdAt: string;
}

export type AccountStatus = "active" | "disabled";
export type LicenseStatus = "active" | "revoked";
export type TeamRole = "owner" | "member";

export interface AccountRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordSalt: string;
  readonly passwordHash: string;
  readonly status: AccountStatus;
  readonly teamId?: string;
  readonly createdAt: string;
}

export interface LicenseRecord {
  readonly id: string;
  readonly accountId: string;
  readonly tokenHash: string;
  readonly planId: string;
  readonly status: LicenseStatus;
  readonly entitlements: readonly string[];
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface QuotaRecord {
  readonly accountId: string;
  readonly limitTokens: number;
  readonly usedTokens: number;
  readonly updatedAt: string;
}

export interface UsageRecord {
  readonly id: string;
  readonly accountId: string;
  readonly requestId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly evidenceId: string;
  readonly createdAt: string;
}

export interface BillingRecord {
  readonly id: string;
  readonly accountId: string;
  readonly usageRecordId: string;
  readonly amountUsd: number;
  readonly currency: "usd";
  readonly provider: "local-ledger" | "stripe";
  readonly status: "recorded" | "stubbed";
  readonly createdAt: string;
}

export interface TeamRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface TeamMemberRecord {
  readonly teamId: string;
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: TeamRole;
  readonly createdAt: string;
}

export interface GatewayPrincipal {
  readonly accountId: string;
  readonly tenantId: string;
  readonly email?: string;
  readonly tokenId: string;
}

export interface GatewayDecisionInput {
  readonly decision: string;
  readonly tenantId?: string;
  readonly accountId?: string;
  readonly actorId?: string;
  readonly subject?: readonly { readonly type: string; readonly id: string }[];
  readonly content: JsonValue;
  readonly method: string;
}

export interface GatewayDecisionRecord {
  readonly evidenceId: string;
  readonly sequence: number;
  readonly head: string;
}

export interface GatewayVerifyResult {
  readonly ok: boolean;
  readonly source: "gateway-ledger";
  readonly checkedAt: string;
  readonly length: number;
  readonly head: string;
  readonly expectedLength?: number;
  readonly expectedHead?: string;
  readonly brokenAt?: number;
  readonly reason?: string;
}

export interface GatewayErrorBody {
  readonly error: string;
  readonly evidenceId?: string;
}

export interface ProvisionAccountRequest {
  readonly email: string;
  readonly displayName?: string;
  readonly planId?: string;
  readonly entitlements?: readonly string[];
}

export interface ProvisionAccountResponse {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string;
  readonly planId: string;
  readonly entitlements: readonly string[];
  readonly accessToken: string;
  readonly licenseToken: string;
  readonly evidenceId: string;
}

export interface SignupRequest {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
}

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
}

export interface LoginResponse {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string;
  readonly accessToken: string;
  readonly evidenceId: string;
}

export interface RevokeLicenseResponse {
  readonly accountId: string;
  readonly revoked: true;
  readonly evidence: {
    readonly auth: string;
    readonly revoke: string;
  };
}

export interface SsoLoginRequest {
  readonly issuer?: string;
}

export interface SsoLoginResponse {
  readonly accountId: string;
  readonly accessToken: string;
  readonly sso: {
    readonly issuer: string;
    readonly subject: string;
    readonly userId: string;
    readonly displayName: string;
  };
  readonly team: {
    readonly id: string;
    readonly name: string;
    readonly role: TeamRole;
    readonly members: readonly {
      readonly accountId: string;
      readonly displayName: string;
      readonly role: TeamRole;
    }[];
  };
  readonly evidence: {
    readonly sso: string;
    readonly team: string;
  };
}

export interface TeamAuditResponse {
  readonly teamId: string;
  readonly teamName: string;
  readonly role: TeamRole;
  readonly usage: {
    readonly totalTokens: number;
    readonly members: readonly {
      readonly accountId: string;
      readonly displayName: string;
      readonly role: TeamRole;
      readonly usedTokens: number;
    }[];
  };
  readonly evidence: {
    readonly auth: string;
    readonly audit: string;
  };
}

export interface GatewayCompletionRequest {
  readonly request?: CompletionRequest;
  readonly prompt?: string;
  readonly model?: string;
  readonly priorityTier?: "standard" | "priority";
}

export interface GatewayCompletionResponse extends CompletionResponse {
  readonly requestId: string;
  readonly usage: ModelUsage;
  readonly tier: {
    readonly tier: "standard" | "priority";
    readonly queue: "standard" | "priority";
    readonly model: string;
    readonly serviceLevel: string;
    readonly source: "gateway-plan";
  };
  readonly evidence: {
    readonly auth: string;
    readonly entitlement: string;
    readonly quota: string;
    readonly tier: string;
    readonly route: string;
    readonly meter: string;
  };
}

export interface GatewayPlanResponse {
  readonly planId: string;
  readonly selectedTier: "standard" | "priority";
  readonly source: "gateway-plan";
  readonly serviceLevel: string;
  readonly tiers: readonly {
    readonly id: "standard" | "priority";
    readonly label: string;
    readonly queue: "standard" | "priority";
    readonly model: string;
    readonly allowed: boolean;
  }[];
  readonly evidence: {
    readonly auth: string;
    readonly tier: string;
  };
}

export interface GatewayQuotaResponse {
  readonly accountId: string;
  readonly planId: string;
  readonly usedTokens: number;
  readonly remainingTokens: number;
  readonly limitTokens: number;
  readonly costUsd: number;
  readonly source: "gateway-db-quota-ledger";
  readonly evidence: {
    readonly auth: string;
    readonly quota: string;
  };
}
