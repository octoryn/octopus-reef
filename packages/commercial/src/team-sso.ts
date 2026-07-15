import { createHash } from "node:crypto";
import { TEST_GATEWAY_LICENSE_TOKEN } from "./index.js";

export type TeamRole = "owner" | "member";

export interface CommercialTeamMember {
  readonly userId: string;
  readonly displayName: string;
  readonly role: TeamRole;
}

export interface CommercialTeamMembership {
  readonly id: string;
  readonly name: string;
  readonly role: TeamRole;
  readonly members: readonly CommercialTeamMember[];
  readonly source: "local-stub-team";
}

export interface StubOidcIdentity {
  readonly source: "in-process-stub-oidc" | "local-stub-oidc";
  readonly issuer: string;
  readonly subject: string;
  readonly userId: string;
  readonly displayName: string;
  readonly licenseToken: string;
  readonly licenseSha256: string;
  readonly team: CommercialTeamMembership;
}

export interface StubOidcSignInOptions {
  /** A local stub issuer. Omit for the deterministic in-process stub. */
  readonly issuer?: string;
  readonly fetchImpl?: typeof fetch;
}

interface StubOidcClaims {
  readonly sub?: unknown;
  readonly preferred_username?: unknown;
  readonly name?: unknown;
  readonly reef_license?: unknown;
  readonly reef_team?: unknown;
}

interface StubTokenResponse {
  readonly id_token?: unknown;
}

/**
 * Sign in through a deliberately tiny local OIDC stub. The external path reads
 * discovery and token endpoints; it never accepts a client secret and records
 * only identity/entitlement metadata in callers' evidence.
 */
export async function signInWithStubOidc(
  options: StubOidcSignInOptions = {},
): Promise<StubOidcIdentity> {
  const issuer = clean(options.issuer);
  if (issuer === undefined) return inProcessStubIdentity();

  const base = localIssuer(issuer);
  const fetchImpl = options.fetchImpl ?? fetch;
  const discoveryResponse = await fetchImpl(
    `${base}/.well-known/openid-configuration`,
    { headers: { accept: "application/json" } },
  );
  if (!discoveryResponse.ok) {
    throw new Error(`stub OIDC discovery returned ${discoveryResponse.status}`);
  }
  const discovery = (await discoveryResponse.json()) as {
    issuer?: unknown;
    token_endpoint?: unknown;
  };
  const discoveredIssuer = clean(discovery.issuer);
  const tokenEndpoint = clean(discovery.token_endpoint);
  if (discoveredIssuer !== base || tokenEndpoint === undefined) {
    throw new Error("stub OIDC discovery response was invalid");
  }
  const endpoint = new URL(tokenEndpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
    throw new Error("stub OIDC token endpoint must be local");
  }

  const tokenResponse = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: "reef-local-stub-code",
      client_id: "reef-local-stub-client",
    }).toString(),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `stub OIDC token exchange returned ${tokenResponse.status}`,
    );
  }
  const token = (await tokenResponse.json()) as StubTokenResponse;
  const claims = parseStubIdToken(token.id_token);
  return identityFromClaims(claims, base, "local-stub-oidc");
}

/** The no-network fallback used by the offline commercial build and tests. */
export function inProcessStubIdentity(): StubOidcIdentity {
  return identityFromClaims(
    {
      sub: "octopus-stub-user",
      preferred_username: "octopus-stub-user",
      name: "Octopus Stub User",
      reef_license: TEST_GATEWAY_LICENSE_TOKEN,
      reef_team: defaultTeam("octopus-stub-user", "Octopus Stub User"),
    },
    "reef://local-stub-idp",
    "in-process-stub-oidc",
  );
}

export function stubIdToken(
  options: {
    readonly userId?: string;
    readonly displayName?: string;
    readonly licenseToken?: string;
  } = {},
): string {
  const userId = clean(options.userId) ?? "octopus-stub-user";
  const displayName = clean(options.displayName) ?? "Octopus Stub User";
  const payload = {
    sub: userId,
    preferred_username: userId,
    name: displayName,
    reef_license: clean(options.licenseToken) ?? TEST_GATEWAY_LICENSE_TOKEN,
    reef_team: defaultTeam(userId, displayName),
  };
  // This is explicitly a local test token: it carries no real authorization
  // claim and is accepted only after a loopback discovery/token exchange.
  return ["eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0", base64url(payload), ""].join(
    ".",
  );
}

function identityFromClaims(
  raw: StubOidcClaims,
  issuer: string,
  source: StubOidcIdentity["source"],
): StubOidcIdentity {
  const userId = clean(raw.preferred_username) ?? clean(raw.sub);
  const subject = clean(raw.sub);
  const displayName = clean(raw.name);
  const licenseToken = clean(raw.reef_license);
  if (
    userId === undefined ||
    subject === undefined ||
    displayName === undefined ||
    licenseToken === undefined
  ) {
    throw new Error("stub OIDC token did not contain a complete identity");
  }
  return {
    source,
    issuer,
    subject,
    userId,
    displayName,
    licenseToken,
    licenseSha256: sha256(licenseToken),
    team: parseTeam(raw.reef_team, userId, displayName),
  };
}

function parseStubIdToken(value: unknown): StubOidcClaims {
  if (typeof value !== "string") throw new Error("stub OIDC token was missing");
  const parts = value.split(".");
  if (parts.length !== 3 || parts[1] === undefined) {
    throw new Error("stub OIDC token was invalid");
  }
  try {
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as StubOidcClaims;
  } catch {
    throw new Error("stub OIDC token payload was invalid");
  }
}

function parseTeam(
  value: unknown,
  userId: string,
  displayName: string,
): CommercialTeamMembership {
  if (value === null || typeof value !== "object") {
    return defaultTeam(userId, displayName);
  }
  const raw = value as {
    id?: unknown;
    name?: unknown;
    role?: unknown;
    members?: unknown;
  };
  const members = Array.isArray(raw.members)
    ? raw.members.flatMap((member) => {
        if (member === null || typeof member !== "object") return [];
        const candidate = member as {
          userId?: unknown;
          displayName?: unknown;
          role?: unknown;
        };
        const memberId = clean(candidate.userId);
        const memberName = clean(candidate.displayName);
        const role = teamRole(candidate.role);
        return memberId !== undefined &&
          memberName !== undefined &&
          role !== undefined
          ? [{ userId: memberId, displayName: memberName, role }]
          : [];
      })
    : [];
  return {
    id: clean(raw.id) ?? "reef-local-team",
    name: clean(raw.name) ?? "Reef Local Team",
    role: teamRole(raw.role) ?? "owner",
    members:
      members.length > 0 ? members : defaultTeam(userId, displayName).members,
    source: "local-stub-team",
  };
}

function defaultTeam(
  userId: string,
  displayName: string,
): CommercialTeamMembership {
  return {
    id: "reef-local-team",
    name: "Reef Local Team",
    role: "owner",
    members: [
      { userId, displayName, role: "owner" },
      {
        userId: "reef-stub-reviewer",
        displayName: "Reef Stub Reviewer",
        role: "member",
      },
    ],
    source: "local-stub-team",
  };
}

function localIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("stub OIDC issuer must be a loopback http URL");
  }
  return url.toString().replace(/\/$/, "");
}

function teamRole(value: unknown): TeamRole | undefined {
  return value === "owner" || value === "member" ? value : undefined;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
