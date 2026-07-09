import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  gatewayEntitlementDecision,
  TEST_GATEWAY_LICENSE_TOKEN,
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

interface StoredAccount {
  readonly userId: string;
  readonly displayName: string;
  readonly licenseToken: string;
  readonly signedInAt: string;
}

export interface AccountSnapshotRequest {
  readonly provider?: string;
  readonly model?: string;
  readonly source?: string;
  readonly gatewayUrl?: string;
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

  login(input: AccountLoginRequest = {}): StoredAccount {
    const account: StoredAccount = {
      userId: clean(input.userId) ?? "octopus-stub-user",
      displayName: clean(input.displayName) ?? "Octopus Stub User",
      licenseToken: clean(input.licenseToken) ?? TEST_GATEWAY_LICENSE_TOKEN,
      signedInAt: new Date().toISOString(),
    };
    this.#account = account;
    this.#save();
    return account;
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
      return { userId, displayName, licenseToken, signedInAt };
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
  const entitlement = entitlementFor(options.edition, options.account);
  const quota =
    options.edition === "commercial"
      ? await commercialQuota({
          ...(options.account !== undefined ? { account: options.account } : {}),
          ...(options.request !== undefined ? { request: options.request } : {}),
          ...(options.fetchImpl !== undefined
            ? { fetchImpl: options.fetchImpl }
            : {}),
        })
      : communityQuota();
  return {
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    edition: options.edition,
    identity,
    account,
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
      reason: "Community runs local BYOK providers only; no Reef plan entitlement is used.",
    };
  }
  if (account === undefined) {
    return {
      allowed: false,
      state: "missing",
      source: "local-stub-account",
      reason: "No Octopus account is signed in; commercial surfaces remain gated.",
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
  const gatewayUrl = clean(options.request?.gatewayUrl) ?? clean(process.env.REEF_GATEWAY_URL);
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
      source:
        clean(body.source) ?? "local-stub-gateway /v1/quota token ledger",
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
