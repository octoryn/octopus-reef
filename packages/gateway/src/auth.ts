import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { GatewayConfig, GatewayPrincipal } from "./types.js";

interface JwtHeader {
  readonly alg: "HS256";
  readonly typ: "JWT";
}

interface GatewayJwtClaims {
  readonly iss: "reef-gateway";
  readonly sub: string;
  readonly aud: "reef-control-plane";
  readonly tenant: string;
  readonly email?: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

export type TokenVerification =
  | { readonly ok: true; readonly principal: GatewayPrincipal }
  | { readonly ok: false; readonly reason: string };

export function issueAccessToken(
  config: GatewayConfig,
  input: {
    readonly accountId: string;
    readonly tenantId?: string;
    readonly email?: string;
    readonly now?: Date;
  },
): string {
  const issued = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const claims: GatewayJwtClaims = {
    iss: "reef-gateway",
    sub: input.accountId,
    aud: "reef-control-plane",
    tenant: input.tenantId ?? input.accountId,
    ...(input.email !== undefined ? { email: input.email } : {}),
    jti: randomUUID(),
    iat: issued,
    exp: issued + config.tokenTtlSeconds,
  };
  return signJwt(claims, config.jwtSecret);
}

export function verifyAccessToken(
  token: string,
  config: GatewayConfig,
  now: Date = new Date(),
): TokenVerification {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed bearer token" };
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];
  let header: JwtHeader;
  let claims: GatewayJwtClaims;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as JwtHeader;
    claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as GatewayJwtClaims;
  } catch {
    return { ok: false, reason: "bearer token is not valid JSON" };
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    return { ok: false, reason: "unsupported bearer token algorithm" };
  }
  const expected = hmac(`${headerPart}.${claimsPart}`, config.jwtSecret);
  if (!constantTimeEqual(signaturePart, expected)) {
    return { ok: false, reason: "bearer token signature failed" };
  }
  if (
    claims.iss !== "reef-gateway" ||
    claims.aud !== "reef-control-plane" ||
    typeof claims.sub !== "string" ||
    typeof claims.tenant !== "string" ||
    typeof claims.jti !== "string"
  ) {
    return { ok: false, reason: "bearer token claims are incomplete" };
  }
  const seconds = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= seconds) {
    return { ok: false, reason: "bearer token expired" };
  }
  return {
    ok: true,
    principal: {
      accountId: claims.sub,
      tenantId: claims.tenant,
      ...(claims.email !== undefined ? { email: claims.email } : {}),
      tokenId: claims.jti,
    },
  };
}

export function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function localPasswordMaterial(email: string): {
  readonly salt: string;
  readonly hash: string;
} {
  return passwordMaterial(email);
}

export function passwordMaterial(password: string): {
  readonly salt: string;
  readonly hash: string;
} {
  const salt = randomBytes(16).toString("base64url");
  return { salt, hash: hashPassword(password, salt) };
}

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

export function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): boolean {
  return constantTimeEqual(hashPassword(password, salt), expectedHash);
}

function signJwt(claims: GatewayJwtClaims, secret: string): string {
  const header = base64url({ alg: "HS256", typ: "JWT" } satisfies JwtHeader);
  const payload = base64url(claims);
  return `${header}.${payload}.${hmac(`${header}.${payload}`, secret)}`;
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
