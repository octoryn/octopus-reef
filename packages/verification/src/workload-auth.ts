import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import {
  VerificationAuthenticationError,
  VerificationAuthorizationError,
} from "./errors.js";
import type { VerificationTenant } from "./types.js";

export const VERIFICATION_PERMISSIONS = [
  "verification:create",
  "verification:read",
  "verification:retry",
  "verification:cancel",
  "verification:evidence:read",
] as const;

export type VerificationPermission = (typeof VERIFICATION_PERMISSIONS)[number];

export interface VerifiedVerificationWorkloadPrincipal {
  readonly subject: string;
  readonly organisationRef: string;
  readonly projectRefs: readonly string[];
  readonly permissions: readonly VerificationPermission[];
}

export interface VerificationWorkloadAuthenticator {
  authenticate(
    authorization: string | undefined,
  ): Promise<VerifiedVerificationWorkloadPrincipal>;
}

export interface VerificationJsonWebKeySet {
  readonly keys: readonly Record<string, unknown>[];
}

export interface JwksVerificationWorkloadAuthenticatorOptions {
  readonly jwks: VerificationJsonWebKeySet;
  readonly issuer: string;
  readonly audience: string;
  readonly now?: () => number;
  readonly clockSkewSeconds?: number;
}

/**
 * Offline, deployment-owned JWKS verification for private workload JWTs.
 * Only RS256 is accepted; tokens never select a remote key URL.
 */
export class JwksVerificationWorkloadAuthenticator implements VerificationWorkloadAuthenticator {
  readonly #keys: ReadonlyMap<string, KeyObject>;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #now: () => number;
  readonly #clockSkewSeconds: number;

  constructor(options: JwksVerificationWorkloadAuthenticatorOptions) {
    if (options.issuer === "" || options.audience === "") {
      throw new Error("verification workload issuer and audience are required");
    }
    const keys = new Map<string, KeyObject>();
    for (const candidate of options.jwks.keys) {
      const kid = candidate["kid"];
      if (
        typeof kid !== "string" ||
        kid === "" ||
        keys.has(kid) ||
        candidate["kty"] !== "RSA" ||
        (candidate["use"] !== undefined && candidate["use"] !== "sig") ||
        (candidate["alg"] !== undefined && candidate["alg"] !== "RS256")
      ) {
        throw new Error("verification workload JWKS contains an invalid key");
      }
      keys.set(
        kid,
        createPublicKey({
          key: candidate as JsonWebKey,
          format: "jwk",
        }),
      );
    }
    if (keys.size === 0) throw new Error("verification workload JWKS is empty");
    this.#keys = keys;
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#clockSkewSeconds = options.clockSkewSeconds ?? 30;
    if (
      !Number.isSafeInteger(this.#clockSkewSeconds) ||
      this.#clockSkewSeconds < 0
    ) {
      throw new Error(
        "verification workload clock skew must be a non-negative integer",
      );
    }
  }

  async authenticate(
    authorization: string | undefined,
  ): Promise<VerifiedVerificationWorkloadPrincipal> {
    try {
      return this.#verify(bearerToken(authorization));
    } catch (error) {
      if (error instanceof VerificationAuthenticationError) throw error;
      throw new VerificationAuthenticationError(
        "verification workload authentication failed",
        {
          cause: error,
        },
      );
    }
  }

  #verify(token: string): VerifiedVerificationWorkloadPrincipal {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part === "")) {
      throw new Error("workload token must be a compact JWT");
    }
    const header = jsonPart(parts[0]!, "workload JWT header");
    if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") {
      throw new Error("workload JWT algorithm or key id is invalid");
    }
    if (header["typ"] !== undefined && header["typ"] !== "JWT") {
      throw new Error("workload JWT type is invalid");
    }
    const key = this.#keys.get(header["kid"]);
    if (key === undefined) throw new Error("workload JWT key is unknown");
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
    const signature = Buffer.from(parts[2]!, "base64url");
    if (!verifySignature("RSA-SHA256", signingInput, key, signature)) {
      throw new Error("workload JWT signature is invalid");
    }

    const claims = jsonPart(parts[1]!, "workload JWT claims");
    const now = this.#now();
    if (
      claims["iss"] !== this.#issuer ||
      !audienceIncludes(claims["aud"], this.#audience)
    ) {
      throw new Error("workload JWT issuer or audience is invalid");
    }
    const expiry = numericDate(claims, "exp");
    if (expiry <= now - this.#clockSkewSeconds)
      throw new Error("workload JWT expired");
    if (
      claims["nbf"] !== undefined &&
      numericDate(claims, "nbf") > now + this.#clockSkewSeconds
    ) {
      throw new Error("workload JWT is not active");
    }
    if (
      claims["iat"] !== undefined &&
      numericDate(claims, "iat") > now + this.#clockSkewSeconds
    ) {
      throw new Error("workload JWT issued-at time is invalid");
    }
    const subject = boundedString(claims["sub"], "workload subject", 512);
    const scope = object(
      claims["reef_verification"],
      "reef_verification claim",
    );
    const organisationRef = opaqueRef(
      scope["organisationRef"],
      "workload organisationRef",
    );
    const projectRefs = stringList(
      scope["projectRefs"],
      "workload projectRefs",
      opaqueRef,
    );
    const permissions = stringList(
      scope["permissions"],
      "workload verification permissions",
      (value, name) => {
        const permission = boundedString(value, name, 128);
        if (
          !(VERIFICATION_PERMISSIONS as readonly string[]).includes(permission)
        ) {
          throw new Error("workload verification permission is unsupported");
        }
        return permission as VerificationPermission;
      },
    );
    if (projectRefs.length === 0 || permissions.length === 0) {
      throw new Error("workload JWT has no verification scope");
    }
    return Object.freeze({
      subject,
      organisationRef,
      projectRefs: Object.freeze(projectRefs),
      permissions: Object.freeze(permissions),
    });
  }
}

export function authorizeVerificationWorkload(
  principal: VerifiedVerificationWorkloadPrincipal,
  tenant: VerificationTenant,
  permission: VerificationPermission,
): void {
  if (
    principal.organisationRef !== tenant.organisationRef ||
    !principal.projectRefs.includes(tenant.projectRef)
  ) {
    throw new VerificationAuthorizationError(
      "verified workload principal is not bound to the requested tenant",
    );
  }
  if (!principal.permissions.includes(permission)) {
    throw new VerificationAuthorizationError(
      "verified workload principal lacks the required verification permission",
    );
  }
}

function bearerToken(authorization: string | undefined): string {
  if (authorization === undefined) {
    throw new VerificationAuthenticationError(
      "verification workload authorization is required",
    );
  }
  const match =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
      authorization,
    );
  if (match === null) {
    throw new VerificationAuthenticationError(
      "verification workload authorization is invalid",
    );
  }
  return match[1]!;
}

function jsonPart(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`${name} is invalid`, { cause: error });
  }
  return object(parsed, name);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function opaqueRef(value: unknown, name: string): string {
  const result = boundedString(value, name, 1024);
  if (result.startsWith("/") || result.includes("://") || result.includes("\\"))
    throw new Error(`${name} is not an opaque reference`);
  return result;
}

function stringList<T extends string>(
  value: unknown,
  name: string,
  parse: (entry: unknown, entryName: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new Error(`${name} is invalid`);
  const result = value.map((entry) => parse(entry, name));
  if (new Set(result).size !== result.length)
    throw new Error(`${name} contains duplicates`);
  return result;
}

function numericDate(claims: Record<string, unknown>, name: string): number {
  const value = claims[name];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`workload JWT ${name} is invalid`);
  }
  return Number(value);
}

function audienceIncludes(value: unknown, expected: string): boolean {
  return (
    value === expected ||
    (Array.isArray(value) &&
      value.every((item) => typeof item === "string") &&
      value.includes(expected))
  );
}
