import { randomBytes } from "node:crypto";
import type { GatewayConfig } from "./types.js";

export function loadGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const host = clean(env.REEF_GATEWAY_HOST) ?? "127.0.0.1";
  const port = intFromEnv(env.REEF_GATEWAY_PORT, 8787, "REEF_GATEWAY_PORT");
  const dbUrl = clean(env.REEF_GATEWAY_DB_URL) ?? "sqlite:.reef-gateway/gateway.sqlite";
  const jwtSecret = clean(env.REEF_GATEWAY_JWT_SECRET);
  const ledgerSecret = clean(env.REEF_GATEWAY_LEDGER_SECRET);
  const adminToken = clean(env.REEF_GATEWAY_ADMIN_TOKEN);
  const bedrockModel = clean(env.REEF_GATEWAY_BEDROCK_MODEL);
  const oidcIssuer = clean(env.REEF_GATEWAY_OIDC_ISSUER);
  const stripeApiKey = clean(env.REEF_GATEWAY_STRIPE_API_KEY);
  const gatewayPort = String(port);
  return {
    host,
    port,
    dbUrl,
    ...(ledgerSecret !== undefined ? { ledgerSecret } : {}),
    jwtSecret: jwtSecret ?? randomBytes(32).toString("base64url"),
    jwtSecretSource: jwtSecret === undefined ? "ephemeral-local" : "env",
    ...(adminToken !== undefined ? { adminToken } : {}),
    rateLimitWindowMs: intFromEnv(
      env.REEF_GATEWAY_RATE_LIMIT_WINDOW_MS,
      60_000,
      "REEF_GATEWAY_RATE_LIMIT_WINDOW_MS",
    ),
    rateLimitRequests: intFromEnv(
      env.REEF_GATEWAY_RATE_LIMIT_REQUESTS,
      60,
      "REEF_GATEWAY_RATE_LIMIT_REQUESTS",
    ),
    defaultQuotaTokens: intFromEnv(
      env.REEF_GATEWAY_DEFAULT_QUOTA_TOKENS,
      10_000,
      "REEF_GATEWAY_DEFAULT_QUOTA_TOKENS",
    ),
    tokenTtlSeconds: intFromEnv(
      env.REEF_GATEWAY_TOKEN_TTL_SECONDS,
      3600,
      "REEF_GATEWAY_TOKEN_TTL_SECONDS",
    ),
    localPricePerThousandTokens: numberFromEnv(
      env.REEF_GATEWAY_LOCAL_PRICE_PER_1K_TOKENS,
      0.002,
      "REEF_GATEWAY_LOCAL_PRICE_PER_1K_TOKENS",
    ),
    ...(bedrockModel !== undefined ? { bedrockModel } : {}),
    awsRegion: clean(env.AWS_REGION) ?? "us-west-2",
    ...(oidcIssuer !== undefined ? { oidcIssuer } : {}),
    oidcClientId: clean(env.REEF_GATEWAY_OIDC_CLIENT_ID) ?? "reef-local-dev",
    oidcRedirectUri:
      clean(env.REEF_GATEWAY_OIDC_REDIRECT_URI) ??
      `http://127.0.0.1:${gatewayPort}/v1/sso/callback`,
    ...(stripeApiKey !== undefined ? { stripeApiKey } : {}),
  };
}

export function dbDriverFor(url: string): "sqlite" | "postgres" {
  if (url.startsWith("sqlite:")) return "sqlite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgres";
  }
  throw new Error(
    "REEF_GATEWAY_DB_URL must start with sqlite:, postgres://, or postgresql://",
  );
}

export function sqliteLocationFromUrl(url: string): string {
  if (!url.startsWith("sqlite:")) {
    throw new Error("not a sqlite db url");
  }
  const location = url.slice("sqlite:".length);
  if (location === "" || location === ":memory:") return ":memory:";
  return location;
}

function intFromEnv(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function numberFromEnv(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
