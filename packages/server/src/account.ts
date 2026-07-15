import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  gatewayEntitlementDecision,
  inProcessStubIdentity,
  priorityModelTier,
  readStubGatewayPriorityPlan,
  signInWithStubOidc,
  type PriorityModelTier,
  type StubOidcIdentity,
} from "@octopus-reef/commercial";
import type { Driver, DriverContext, DriverStep } from "@octopus-reef/engine";
import type {
  AccountIdentityView,
  AccountLoginRequest,
  AccountPlanResponse,
  AccountQuotaView,
  AccountUserView,
  ReefEdition,
  UsageSummaryResponse,
} from "@octopus-reef/protocol";

export interface StoredAccount {
  readonly userId: string;
  readonly displayName: string;
  readonly licenseToken: string;
  readonly signedInAt: string;
  readonly sso: StubOidcIdentity;
}

export interface AccountSnapshotRequest {
  readonly provider?: string;
  readonly model?: string;
  readonly source?: string;
  readonly gatewayUrl?: string;
  readonly ssoUrl?: string;
  readonly priorityTier?: PriorityModelTier;
}

export class AccountStore {
  readonly #path: string | undefined;
  #account: StoredAccount | undefined;

  constructor(persistDir?: string) {
    this.#path =
      persistDir === undefined ? undefined : join(persistDir, "account.json");
    this.#account = this.#load();
  }

  current(): StoredAccount | undefined {
    return this.#account;
  }

  async login(input: AccountLoginRequest = {}): Promise<StoredAccount> {
    const issuer = clean(input.ssoUrl);
    const oidc = await signInWithStubOidc(
      issuer === undefined ? {} : { issuer },
    );
    const userId = clean(input.userId) ?? oidc.userId;
    const displayName = clean(input.displayName) ?? oidc.displayName;
    // When a hosted gateway is configured, authenticate against it for a REAL
    // token that governed sessions can use; otherwise keep the local stub token.
    let licenseToken = clean(input.licenseToken) ?? oidc.licenseToken;
    const gatewayUrl = clean(process.env.REEF_GATEWAY_URL);
    if (clean(input.licenseToken) === undefined && gatewayUrl !== undefined) {
      const real = await this.#gatewayToken(gatewayUrl, displayName).catch(
        () => undefined,
      );
      if (real !== undefined) licenseToken = real;
    }
    const account: StoredAccount = {
      userId,
      displayName,
      licenseToken,
      signedInAt: new Date().toISOString(),
      sso: identityForAccount(oidc, userId, displayName, licenseToken),
    };
    this.#account = account;
    this.#save();
    return account;
  }

  // Provision a real hosted-gateway token by signing up an account on the gateway.
  // Each sign-in mints a fresh gateway account (fine for BYOK-hosted staging); the
  // returned JWT is what governed sessions send to the gateway.
  async #gatewayToken(
    gatewayUrl: string,
    displayName: string,
  ): Promise<string> {
    const res = await fetch(`${trimTrailingSlash(gatewayUrl)}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `reef-${randomUUID()}@reef.local`,
        password: randomUUID(),
        displayName,
      }),
    });
    if (!res.ok) throw new Error(`gateway signup failed: ${res.status}`);
    const body = (await res.json()) as { accessToken?: string };
    const token = clean(body.accessToken);
    if (token === undefined)
      throw new Error("gateway signup returned no token");
    return token;
  }

  logout(): void {
    this.#account = undefined;
    this.#save();
  }

  #load(): StoredAccount | undefined {
    if (this.#path === undefined || !existsSync(this.#path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as {
        userId?: unknown;
        displayName?: unknown;
        licenseToken?: unknown;
        signedInAt?: unknown;
        sso?: unknown;
      };
      const userId = clean(parsed.userId);
      const displayName = clean(parsed.displayName);
      const licenseToken = clean(parsed.licenseToken);
      const signedInAt = clean(parsed.signedInAt);
      if (
        userId === undefined ||
        displayName === undefined ||
        licenseToken === undefined ||
        signedInAt === undefined
      ) {
        return undefined;
      }
      return {
        userId,
        displayName,
        licenseToken,
        signedInAt,
        sso: parseStoredSso(parsed.sso, userId, displayName, licenseToken),
      };
    } catch {
      return undefined;
    }
  }

  #save(): void {
    if (this.#path === undefined) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(
      this.#path,
      JSON.stringify(
        this.#account === undefined
          ? { signedIn: false }
          : {
              userId: this.#account.userId,
              displayName: this.#account.displayName,
              licenseToken: this.#account.licenseToken,
              signedInAt: this.#account.signedInAt,
              sso: this.#account.sso,
            },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
}

export class AccountPlanDriver implements Driver {
  readonly name = "account-plan";
  readonly #plan: () => Promise<AccountPlanResponse>;

  constructor(plan: () => Promise<AccountPlanResponse>) {
    this.#plan = plan;
  }

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    const plan = await this.#plan();
    yield {
      type: "observe",
      summary: `account identity snapshot: ${plan.identity.label}`,
      data: {
        accountIdentity: plan.identity,
        account: plan.account,
        task: ctx.task,
      },
    };
    yield {
      type: "observe",
      summary: `OIDC SSO decision: ${plan.sso.state}`,
      data: { ssoDecision: plan.sso },
    };
    yield {
      type: "observe",
      summary: `team membership: ${plan.team.gated ? "gated" : (plan.team.name ?? "unknown")}`,
      data: { teamMembership: plan.team },
    };
    yield {
      type: "observe",
      summary: `account entitlement: ${plan.entitlement.allowed ? "allowed" : "denied"}`,
      data: { accountEntitlement: plan.entitlement },
    };
    yield {
      type: "observe",
      summary: `account usage: ${plan.usage.totals.totalTokens} tokens`,
      data: {
        accountUsage: {
          source: "N6 session evidence aggregation",
          totals: plan.usage.totals,
          sessions: plan.usage.sessions.length,
          generatedAt: plan.usage.generatedAt,
        },
      },
    };
    yield {
      type: "observe",
      summary: `plan quota: ${plan.plan.quota.status}`,
      data: { planQuota: plan.plan.quota, plan: plan.plan.name },
    };
    yield {
      type: "observe",
      summary: `priority model tier: ${plan.priority.selectedTier}`,
      data: { priorityTierDecision: plan.priority },
    };
    yield {
      type: "done",
      summary: `account plan snapshot sealed for ${plan.edition}`,
    };
  }
}

export async function accountPlan(options: {
  readonly edition: ReefEdition;
  readonly usage: UsageSummaryResponse;
  readonly account?: StoredAccount;
  readonly request?: AccountSnapshotRequest;
  readonly now?: () => string;
  readonly fetchImpl?: typeof fetch;
}): Promise<AccountPlanResponse> {
  const identity = identityFor(options.edition, options.request);
  const account = accountView(options.edition, options.account);
  const governance = accountGovernanceContext(options.edition, options.account);
  const entitlement = entitlementFor(options.edition, options.account);
  const quota =
    options.edition === "commercial"
      ? await commercialQuota({
          ...(options.account !== undefined
            ? { account: options.account }
            : {}),
          ...(options.request !== undefined
            ? { request: options.request }
            : {}),
          ...(options.fetchImpl !== undefined
            ? { fetchImpl: options.fetchImpl }
            : {}),
        })
      : communityQuota();
  const priority = await priorityPlan({
    edition: options.edition,
    ...(options.account !== undefined ? { account: options.account } : {}),
    ...(options.request !== undefined ? { request: options.request } : {}),
    ...(options.fetchImpl !== undefined
      ? { fetchImpl: options.fetchImpl }
      : {}),
  });
  return {
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    edition: options.edition,
    identity,
    account,
    sso: governance.sso,
    team: governance.team,
    audit: {
      gated: governance.team.gated,
      source: governance.team.source,
      message: governance.team.gated
        ? "Sign in with the local stub SSO to inspect team evidence."
        : "Team audit is supplied by the Reef daemon's persisted evidence verifier.",
      sessions: [],
    },
    entitlement,
    usage: options.usage,
    plan: {
      name:
        options.edition === "commercial"
          ? "Octopus Commercial Stub"
          : "Community BYOK",
      upgradeAvailable: options.edition === "commercial",
      quota,
    },
    priority,
  };
}

export function accountGovernanceContext(
  edition: ReefEdition,
  account: StoredAccount | undefined,
): Pick<AccountPlanResponse, "sso" | "team" | "entitlement"> {
  const entitlement = entitlementFor(edition, account);
  if (edition === "community") {
    return {
      entitlement,
      sso: {
        state: "community",
        source: "community-edition",
        message:
          "Community uses local BYOK identity; team SSO is not compiled into this edition.",
      },
      team: {
        gated: true,
        source: "community-edition",
        message: "Team membership is commercial-only.",
      },
    };
  }
  if (account === undefined) {
    return {
      entitlement,
      sso: {
        state: "gated",
        source: "local-stub-oidc",
        message:
          "Sign in through the local stub OIDC provider to unlock the commercial team surface.",
      },
      team: {
        gated: true,
        source: "local-stub-team",
        message: "No signed-in team membership is available.",
      },
    };
  }
  return {
    entitlement,
    sso: {
      state: "signed-in",
      source: account.sso.source,
      issuer: account.sso.issuer,
      subject: account.sso.subject,
      message:
        "Local stub OIDC discovery and token exchange granted the commercial entitlement.",
    },
    team: {
      gated: false,
      source: account.sso.team.source,
      message: "Membership came from the local stub OIDC team claim.",
      id: account.sso.team.id,
      name: account.sso.team.name,
      role: account.sso.team.role,
      members: account.sso.team.members,
    },
  };
}

function identityFor(
  edition: ReefEdition,
  request: AccountSnapshotRequest | undefined,
): AccountIdentityView {
  const provider = clean(request?.provider) ?? "mock";
  const model = clean(request?.model) ?? "offline-mock";
  if (edition === "commercial") {
    return {
      kind: "octopus-account",
      label: `Octopus account · ${providerLabel(provider)} · ${model}`,
      provider,
      model,
      source: clean(request?.source) ?? "Reef local account stub",
    };
  }
  return {
    kind: "local-byok",
    label: `${providerLabel(provider)} · ${model}`,
    provider,
    model,
    source: clean(request?.source) ?? "Local BYOK / offline mock settings",
  };
}

function accountView(
  edition: ReefEdition,
  account: StoredAccount | undefined,
): AccountUserView {
  if (edition === "community") {
    return {
      signedIn: false,
      source: "local-byok",
    };
  }
  if (account === undefined) {
    return {
      signedIn: false,
      source: "local-stub-account",
    };
  }
  return {
    signedIn: true,
    source: "local-stub-account",
    userId: account.userId,
    displayName: account.displayName,
    licenseSha256: sha256(account.licenseToken),
  };
}

function entitlementFor(
  edition: ReefEdition,
  account: StoredAccount | undefined,
): AccountPlanResponse["entitlement"] {
  if (edition === "community") {
    return {
      allowed: true,
      state: "community-byok",
      source: "community-edition",
      reason:
        "Community runs local BYOK providers only; no Reef plan entitlement is used.",
    };
  }
  if (account === undefined) {
    return {
      allowed: false,
      state: "missing",
      source: "local-stub-account",
      reason:
        "No Octopus account is signed in; commercial surfaces remain gated.",
    };
  }
  const decision = gatewayEntitlementDecision({
    licenseToken: account.licenseToken,
  });
  return {
    allowed: decision.allowed,
    state: decision.allowed ? "licensed" : "missing",
    source: decision.source,
    reason: decision.reason,
    ...(decision.licenseSha256 !== undefined
      ? { licenseSha256: decision.licenseSha256 }
      : {}),
  };
}

function communityQuota(): AccountQuotaView {
  return {
    status: "not-available",
    source: "community-edition",
    message:
      "Community uses your own BYOK provider usage. Reef plan credits are not shown.",
  };
}

async function priorityPlan(options: {
  readonly edition: ReefEdition;
  readonly account?: StoredAccount;
  readonly request?: AccountSnapshotRequest;
  readonly fetchImpl?: typeof fetch;
}): Promise<AccountPlanResponse["priority"]> {
  const selectedTier = priorityModelTier(options.request?.priorityTier);
  if (options.edition === "community") {
    return {
      gated: true,
      available: false,
      selectedTier,
      source: "community-edition",
      serviceLevel: "Community does not include commercial priority routing.",
      message: "Priority model selection is commercial-only.",
      tiers: [],
    };
  }
  if (options.account === undefined) {
    return {
      gated: true,
      available: false,
      selectedTier,
      source: "local-stub-account",
      serviceLevel: "Sign in to read the local commercial plan source.",
      message:
        "Sign in to the local Octopus stub account before selecting a tier.",
      tiers: [],
    };
  }
  const gatewayUrl =
    clean(options.request?.gatewayUrl) ?? clean(process.env.REEF_GATEWAY_URL);
  if (gatewayUrl === undefined) {
    return {
      gated: true,
      available: false,
      selectedTier,
      source: "REEF_GATEWAY_URL",
      serviceLevel:
        "No plan source is configured, so Reef does not claim an SLA.",
      message: "Configure the local stub gateway to read priority tiers.",
      tiers: [],
    };
  }
  try {
    const plan = await readStubGatewayPriorityPlan({
      gatewayUrl,
      licenseToken: options.account.licenseToken,
      priorityTier: selectedTier,
      ...(options.fetchImpl !== undefined
        ? { fetchImpl: options.fetchImpl }
        : {}),
    });
    return {
      gated: false,
      available: true,
      selectedTier: plan.selectedTier,
      source: plan.source,
      serviceLevel: plan.serviceLevel,
      message:
        "Tier and service-level text were read from the local stub gateway.",
      tiers: plan.tiers,
    };
  } catch (err) {
    return {
      gated: true,
      available: false,
      selectedTier,
      source: "local-stub-gateway /v1/plan",
      serviceLevel:
        "The local plan source was unavailable; Reef does not claim an SLA.",
      message: err instanceof Error ? err.message : String(err),
      tiers: [],
    };
  }
}

async function commercialQuota(options: {
  readonly account?: StoredAccount;
  readonly request?: AccountSnapshotRequest;
  readonly fetchImpl?: typeof fetch;
}): Promise<AccountQuotaView> {
  if (options.account === undefined) {
    return {
      status: "missing-account",
      source: "local-stub-account",
      message: "Sign in to the local Octopus stub account to read plan quota.",
    };
  }
  const gatewayUrl =
    clean(options.request?.gatewayUrl) ?? clean(process.env.REEF_GATEWAY_URL);
  if (gatewayUrl === undefined) {
    return {
      status: "not-available",
      source: "REEF_GATEWAY_URL",
      message:
        "No gateway URL is configured, so there is no clean remaining quota source.",
    };
  }
  try {
    const res = await (options.fetchImpl ?? fetch)(
      `${trimTrailingSlash(gatewayUrl)}/v1/quota`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${options.account.licenseToken}`,
        },
      },
    );
    if (!res.ok) {
      return {
        status: "error",
        source: "local-stub-gateway /v1/quota",
        message: `Quota source returned ${res.status} ${res.statusText}.`,
      };
    }
    const body = (await res.json()) as {
      planId?: unknown;
      usedTokens?: unknown;
      remainingTokens?: unknown;
      limitTokens?: unknown;
      resetAt?: unknown;
      source?: unknown;
    };
    const usedTokens = finiteNumber(body.usedTokens);
    const remainingTokens = finiteNumber(body.remainingTokens);
    const limitTokens = finiteNumber(body.limitTokens);
    if (
      usedTokens === undefined ||
      remainingTokens === undefined ||
      limitTokens === undefined
    ) {
      return {
        status: "error",
        source: "local-stub-gateway /v1/quota",
        message: "Quota source did not return numeric used/remaining tokens.",
      };
    }
    return {
      status: "available",
      source: clean(body.source) ?? "local-stub-gateway /v1/quota token ledger",
      message: "Quota comes from the local stub gateway token ledger.",
      planId: clean(body.planId) ?? "reef-commercial-stub",
      usedTokens,
      remainingTokens,
      limitTokens,
      ...(typeof body.resetAt === "string" && body.resetAt.trim() !== ""
        ? { resetAt: body.resetAt }
        : {}),
    };
  } catch (err) {
    return {
      status: "error",
      source: "local-stub-gateway /v1/quota",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "bedrock":
      return "Bedrock";
    case "gateway":
      return "Octopus Gateway";
    case "mock":
      return "Offline mock";
    default:
      return provider;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function identityForAccount(
  identity: StubOidcIdentity,
  userId: string,
  displayName: string,
  licenseToken: string,
): StubOidcIdentity {
  return {
    ...identity,
    userId,
    displayName,
    licenseToken,
    licenseSha256: sha256(licenseToken),
    team: {
      ...identity.team,
      members: identity.team.members.map((member) =>
        member.userId === identity.userId
          ? { ...member, userId, displayName }
          : member,
      ),
    },
  };
}

function parseStoredSso(
  value: unknown,
  userId: string,
  displayName: string,
  licenseToken: string,
): StubOidcIdentity {
  if (value !== null && typeof value === "object") {
    const candidate = value as Partial<StubOidcIdentity>;
    if (
      (candidate.source === "in-process-stub-oidc" ||
        candidate.source === "local-stub-oidc") &&
      clean(candidate.issuer) !== undefined &&
      clean(candidate.subject) !== undefined &&
      candidate.team !== undefined
    ) {
      return identityForAccount(
        candidate as StubOidcIdentity,
        userId,
        displayName,
        licenseToken,
      );
    }
  }
  // Accounts written before C4 had no SSO object. Treat them as the same local
  // stub identity so an existing offline profile remains usable, not privileged.
  return identityForAccount(
    inProcessStubIdentity(),
    userId,
    displayName,
    licenseToken,
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
