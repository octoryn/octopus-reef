import { createHash } from "node:crypto";
import type { CompletionRequest, ModelUsage } from "@octopus-reef/agent";
import { ProviderError, type CompletionResponse } from "@octopus-reef/agent";

export {
  inProcessStubIdentity,
  signInWithStubOidc,
  type CommercialTeamMember,
  type CommercialTeamMembership,
  type StubOidcIdentity,
} from "./team-sso.js";

export type ReefEdition = "community" | "commercial";

export const COMMERCIAL_COMMAND = "reef.openCommercial";
export const COMMERCIAL_COMMAND_TITLE = "Reef: Commercial";
export const GATEWAY_PROVIDER_NAME = "gateway";
export const TEST_GATEWAY_LICENSE_TOKEN = "reef-test-license";

export interface EntitlementStatus {
  readonly state: "licensed" | "missing";
  readonly source: "local-env" | "not-configured";
  readonly summary: string;
}

export interface GatewayEntitlementDecision {
  readonly allowed: boolean;
  readonly source: "local-license" | "not-configured";
  readonly licenseSha256?: string;
  readonly reason: string;
}

export interface GatewayQuotaDecision {
  readonly allowed: boolean;
  readonly source: "local-stub" | "gateway-policy";
  readonly remainingRequests?: number;
  readonly reason: string;
}

export type PriorityModelTier = "standard" | "priority";

export interface GatewayPriorityTierDecision {
  readonly tier: PriorityModelTier;
  readonly queue: "standard" | "priority";
  readonly model: string;
  readonly source: "commercial-priority-config";
  readonly message: string;
}

export interface StubGatewayPlanTier {
  readonly id: PriorityModelTier;
  readonly label: string;
  readonly queue: "standard" | "priority";
  readonly model: string;
}

export interface StubGatewayPriorityPlan {
  readonly planId: string;
  readonly selectedTier: PriorityModelTier;
  readonly source: string;
  readonly serviceLevel: string;
  readonly tiers: readonly StubGatewayPlanTier[];
}

export interface GatewayRouteDecision {
  readonly provider: "gateway";
  readonly gatewayUrl: string;
  readonly route: string;
  readonly model: string;
  readonly priority: GatewayPriorityTierDecision;
  readonly licenseSha256: string;
}

export interface GatewayProviderOptions {
  readonly gatewayUrl: string;
  readonly licenseToken?: string;
  readonly accessToken?: string;
  readonly model?: string;
  readonly priorityTier?: PriorityModelTier;
  readonly fetchImpl?: typeof fetch;
}

export class GatewayProvider {
  readonly name = GATEWAY_PROVIDER_NAME;
  readonly #gatewayUrl: string;
  readonly #authToken: string | undefined;
  readonly #model: string;
  readonly #priorityTier: PriorityModelTier;
  readonly #fetch: typeof fetch;

  constructor(options: GatewayProviderOptions) {
    this.#gatewayUrl = trimTrailingSlash(options.gatewayUrl);
    this.#authToken = clean(options.accessToken) ?? clean(options.licenseToken);
    this.#priorityTier = priorityModelTier(options.priorityTier);
    this.#model = options.model ?? priorityTierModel(this.#priorityTier);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.#authToken === undefined) {
      throw new ProviderError("gateway auth token is required");
    }
    const res = await this.#fetch(`${this.#gatewayUrl}/v1/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.#model,
        priorityTier: this.#priorityTier,
        request,
      }),
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") detail = body.error;
      } catch {
        /* keep HTTP status */
      }
      throw new ProviderError(`gateway request failed: ${detail}`);
    }
    const body = (await res.json()) as CompletionResponse & {
      readonly usage?: ModelUsage;
    };
    if (!Array.isArray(body.content) || typeof body.stopReason !== "string") {
      throw new ProviderError("gateway returned an invalid completion");
    }
    return {
      content: body.content,
      stopReason: body.stopReason,
      ...(body.usage !== undefined ? { usage: body.usage } : {}),
    };
  }
}

export interface CommercialSurfaceStatus {
  readonly edition: "commercial";
  readonly entitlement: EntitlementStatus;
  readonly surfaces: readonly {
    readonly id: string;
    readonly title: string;
    readonly gated: boolean;
    readonly reason: string;
  }[];
}

export function resolveEntitlementStatus(
  options: {
    readonly licenseToken?: string;
  } = {},
): EntitlementStatus {
  const token =
    clean(options.licenseToken) ??
    clean(process.env.REEF_LICENSE_TOKEN) ??
    clean(process.env.REEF_ENTITLEMENT_TOKEN);
  if (token === undefined) {
    return {
      state: "missing",
      source: "not-configured",
      summary: "No local license token configured.",
    };
  }
  return {
    state: "licensed",
    source: "local-env",
    summary: "Local license token is configured.",
  };
}

export function gatewayEntitlementDecision(options: {
  readonly licenseToken?: string;
}): GatewayEntitlementDecision {
  const token = clean(options.licenseToken);
  if (token === undefined) {
    return {
      allowed: false,
      source: "not-configured",
      reason: "No Reef commercial license token was provided.",
    };
  }
  return {
    allowed: true,
    source: "local-license",
    licenseSha256: sha256(token),
    reason: "A local Reef commercial license token was provided.",
  };
}

export function gatewayQuotaDecision(options: {
  readonly entitlementAllowed: boolean;
}): GatewayQuotaDecision {
  if (!options.entitlementAllowed) {
    return {
      allowed: false,
      source: "local-stub",
      reason: "Quota denied because entitlement was denied.",
    };
  }
  return {
    allowed: true,
    source: "local-stub",
    reason:
      "Offline stub entitlement permits this request; plan token quota is read from the gateway quota ledger.",
  };
}

export function gatewayRouteDecision(options: {
  readonly gatewayUrl: string;
  readonly model?: string;
  readonly priorityTier?: PriorityModelTier;
  readonly licenseToken: string;
}): GatewayRouteDecision {
  const priority = gatewayPriorityTierDecision({
    ...(options.priorityTier !== undefined
      ? { priorityTier: options.priorityTier }
      : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
  });
  return {
    provider: "gateway",
    gatewayUrl: trimTrailingSlash(options.gatewayUrl),
    route: "/v1/completions",
    model: priority.model,
    priority,
    licenseSha256: sha256(options.licenseToken),
  };
}

/** Normalizes the only two commercial routing tiers accepted by the local stub. */
export function priorityModelTier(value: unknown): PriorityModelTier {
  return value === "priority" ? "priority" : "standard";
}

export function priorityTierModel(tier: PriorityModelTier): string {
  return tier === "priority"
    ? "reef-gateway-priority-stub"
    : "reef-gateway-stub";
}

export function gatewayPriorityTierDecision(options: {
  readonly priorityTier?: PriorityModelTier;
  readonly model?: string;
}): GatewayPriorityTierDecision {
  const tier = priorityModelTier(options.priorityTier);
  return {
    tier,
    queue: tier === "priority" ? "priority" : "standard",
    model: options.model ?? priorityTierModel(tier),
    source: "commercial-priority-config",
    message:
      tier === "priority"
        ? "Priority routing was selected from the commercial local configuration."
        : "Standard routing was selected from the commercial local configuration.",
  };
}

/** Reads plan/tier text from the local stub instead of inventing an SLA in UI. */
export async function readStubGatewayPriorityPlan(options: {
  readonly gatewayUrl: string;
  readonly licenseToken: string;
  readonly priorityTier?: PriorityModelTier;
  readonly fetchImpl?: typeof fetch;
}): Promise<StubGatewayPriorityPlan> {
  const tier = priorityModelTier(options.priorityTier);
  const url = new URL("/v1/plan", trimTrailingSlash(options.gatewayUrl));
  url.searchParams.set("tier", tier);
  const res = await (options.fetchImpl ?? fetch)(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${options.licenseToken}`,
    },
  });
  if (!res.ok) {
    throw new ProviderError(
      `priority plan source returned ${res.status} ${res.statusText}`,
    );
  }
  return parseStubGatewayPriorityPlan(await res.json());
}

export function commercialSurfaceStatus(
  options: {
    readonly licenseToken?: string;
  } = {},
): CommercialSurfaceStatus {
  const entitlement = resolveEntitlementStatus(options);
  const gated = entitlement.state !== "licensed";
  return {
    edition: "commercial",
    entitlement,
    surfaces: [
      {
        id: "hosted-bedrock-gateway",
        title: "Hosted Bedrock Gateway",
        gated,
        reason: gated
          ? "Entitlement is missing; gateway routing is disabled."
          : "Entitlement is present; gateway routing may be used.",
      },
      {
        id: "commercial-governance",
        title: "Commercial Governance",
        gated,
        reason: gated
          ? "Commercial workflows are visible but locked until entitlement verifies."
          : "Commercial workflows are unlocked for this licensed session.",
      },
    ],
  };
}

export function commercialWebviewHtml(
  cspSource: string,
  status: CommercialSurfaceStatus = commercialSurfaceStatus(),
): string {
  const entitlementClass =
    status.entitlement.state === "licensed" ? "ok" : "locked";
  const rows = status.surfaces
    .map(
      (surface) => `<article class="surface ${surface.gated ? "locked" : "ok"}">
  <div>
    <h2>${escapeHtml(surface.title)}</h2>
    <p>${escapeHtml(surface.reason)}</p>
  </div>
  <span>${surface.gated ? "Gated OFF" : "Available"}</span>
</article>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';" />
<style>
  :root{--deep:#091315;--panel:#0f1d20;--panel2:#132529;--line:#214044;--ink:#edf6f4;--muted:#86a5a5;--signal:#3de0be;--warn:#ffd166;--mono:ui-monospace,Menlo,monospace}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
  header b{color:var(--signal)}
  main{padding:16px;display:grid;gap:12px}
  .entitlement{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:flex;justify-content:space-between;gap:12px}
  .entitlement strong{color:var(--ink)}
  .entitlement span,.surface span{white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--muted);align-self:start}
  .entitlement.ok span,.surface.ok span{color:var(--signal);border-color:rgba(61,224,190,.5)}
  .entitlement.locked span,.surface.locked span{color:var(--warn);border-color:rgba(255,209,102,.55)}
  .surface{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:flex;justify-content:space-between;gap:12px}
  h2{font-size:13px;margin:0 0 6px;color:var(--ink)}
  p{margin:0;color:var(--muted);line-height:1.45}
</style>
</head>
<body>
<header><div><b>&#x259A; reef</b> commercial</div><div>${status.edition}</div></header>
<main>
  <section class="entitlement ${entitlementClass}">
    <div><strong>Entitlement</strong><p>${escapeHtml(status.entitlement.summary)}</p></div>
    <span>${status.entitlement.state === "licensed" ? "Licensed" : "Missing"}</span>
  </section>
  ${rows}
</main>
</body>
</html>`;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseStubGatewayPriorityPlan(value: unknown): StubGatewayPriorityPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError(
      "priority plan source returned an invalid response",
    );
  }
  const candidate = value as Record<string, unknown>;
  const planId = cleanString(candidate.planId);
  const source = cleanString(candidate.source);
  const serviceLevel = cleanString(candidate.serviceLevel);
  const tiers = Array.isArray(candidate.tiers)
    ? candidate.tiers.flatMap((entry) => parseStubGatewayPlanTier(entry))
    : [];
  if (
    planId === undefined ||
    source === undefined ||
    serviceLevel === undefined ||
    tiers.length !== 2
  ) {
    throw new ProviderError(
      "priority plan source omitted required tier metadata",
    );
  }
  return {
    planId,
    selectedTier: priorityModelTier(candidate.selectedTier),
    source,
    serviceLevel,
    tiers,
  };
}

function parseStubGatewayPlanTier(value: unknown): StubGatewayPlanTier[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const candidate = value as Record<string, unknown>;
  const id = priorityModelTier(candidate.id);
  const label = cleanString(candidate.label);
  const model = cleanString(candidate.model);
  const queue = candidate.queue === "priority" ? "priority" : "standard";
  if (label === undefined || model === undefined || candidate.id !== id)
    return [];
  return [{ id, label, queue, model }];
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
