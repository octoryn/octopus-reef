import type { ChainLink, Evidence, JsonValue } from "octopus-evidence";

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
