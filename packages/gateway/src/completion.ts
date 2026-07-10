import { randomUUID } from "node:crypto";
import type {
  CompletionRequest,
  CompletionResponse,
  ModelProvider,
  ModelUsage,
} from "@octopus-reef/agent";
import type { JsonValue } from "octopus-evidence";
import type { GatewayDb } from "./db.js";
import type { GatewayLedger } from "./ledger.js";
import type {
  GatewayCompletionRequest,
  GatewayCompletionResponse,
  GatewayPrincipal,
  LicenseRecord,
} from "./types.js";

export interface CompletionServiceOptions {
  readonly db: GatewayDb;
  readonly ledger: GatewayLedger;
  readonly provider: ModelProvider;
}

export type CompletionOutcome =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly body: GatewayCompletionResponse;
    }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 400 | 502;
      readonly body: { readonly error: string; readonly evidenceId?: string };
    };

export class CompletionService {
  readonly #db: GatewayDb;
  readonly #ledger: GatewayLedger;
  readonly #provider: ModelProvider;

  constructor(options: CompletionServiceOptions) {
    this.#db = options.db;
    this.#ledger = options.ledger;
    this.#provider = options.provider;
  }

  async complete(input: {
    readonly principal:
      | { readonly ok: true; readonly value: GatewayPrincipal }
      | { readonly ok: false; readonly reason: string };
    readonly body: unknown;
  }): Promise<CompletionOutcome> {
    const authEvidence = await this.#ledger.appendDecision({
      decision: "auth",
      method: "jwt",
      ...(input.principal.ok
        ? {
            tenantId: input.principal.value.tenantId,
            accountId: input.principal.value.accountId,
            actorId: input.principal.value.accountId,
          }
        : {}),
      content: {
        allowed: input.principal.ok,
        reason: input.principal.ok ? "signed JWT verified" : input.principal.reason,
      },
    });
    if (!input.principal.ok) {
      return {
        ok: false,
        status: 401,
        body: { error: "auth denied", evidenceId: authEvidence.evidenceId },
      };
    }

    const principal = input.principal.value;
    const entitlement = await this.#entitlementFor(principal.accountId);
    const entitlementEvidence = await this.#ledger.appendDecision({
      decision: "entitlement",
      method: "db-license",
      tenantId: principal.tenantId,
      accountId: principal.accountId,
      actorId: principal.accountId,
      content: asJson(entitlement),
    });
    if (!entitlement.allowed) {
      return {
        ok: false,
        status: 403,
        body: {
          error: entitlement.reason,
          evidenceId: entitlementEvidence.evidenceId,
        },
      };
    }

    let request: CompletionRequest;
    try {
      request = parseCompletionRequest(input.body);
    } catch (error) {
      return {
        ok: false,
        status: 400,
        body: {
          error: error instanceof Error ? error.message : String(error),
          evidenceId: entitlementEvidence.evidenceId,
        },
      };
    }
    const requestId = randomUUID();
    const routeEvidence = await this.#ledger.appendDecision({
      decision: "route",
      method: "model-provider",
      tenantId: principal.tenantId,
      accountId: principal.accountId,
      actorId: principal.accountId,
      content: {
        allowed: true,
        requestId,
        provider: this.#provider.name,
        model: modelFromRequest(input.body) ?? "provider-default",
        bedrock: (process.env.AWS_BEARER_TOKEN_BEDROCK ?? "").trim() !== "",
      },
    });

    let completion: CompletionResponse;
    try {
      completion = await this.#provider.complete(request);
    } catch (error) {
      const failure = await this.#ledger.appendDecision({
        decision: "route",
        method: "model-provider",
        tenantId: principal.tenantId,
        accountId: principal.accountId,
        actorId: principal.accountId,
        content: {
          allowed: false,
          requestId,
          provider: this.#provider.name,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      return {
        ok: false,
        status: 502,
        body: { error: "model provider failed", evidenceId: failure.evidenceId },
      };
    }

    const usage = normalizeUsage(completion.usage, this.#provider.name);
    const meterEvidence = await this.#ledger.appendDecision({
      decision: "meter",
      method: "provider-usage",
      tenantId: principal.tenantId,
      accountId: principal.accountId,
      actorId: principal.accountId,
      content: asJson({
        allowed: true,
        requestId,
        usage,
        source: "provider-normalized-usage",
      }),
    });
    await this.#db.appendUsageRecord({
      id: randomUUID(),
      accountId: principal.accountId,
      requestId,
      model: usage.model,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      costUsd: 0,
      evidenceId: meterEvidence.evidenceId,
      createdAt: new Date().toISOString(),
    });

    return {
      ok: true,
      status: 200,
      body: {
        content: completion.content,
        stopReason: completion.stopReason,
        usage,
        requestId,
        evidence: {
          auth: authEvidence.evidenceId,
          entitlement: entitlementEvidence.evidenceId,
          route: routeEvidence.evidenceId,
          meter: meterEvidence.evidenceId,
        },
      },
    };
  }

  async #entitlementFor(accountId: string): Promise<{
    readonly allowed: boolean;
    readonly accountId: string;
    readonly licenseId?: string;
    readonly planId?: string;
    readonly entitlements?: readonly string[];
    readonly reason: string;
  }> {
    const account = await this.#db.getAccount(accountId);
    if (account === undefined || account.status !== "active") {
      return {
        allowed: false,
        accountId,
        reason: "account is missing or disabled",
      };
    }
    const license = await this.#db.getActiveLicenseByAccount(accountId);
    if (license === undefined) {
      return {
        allowed: false,
        accountId,
        reason: "active license is missing",
      };
    }
    if (!license.entitlements.includes("inference:complete")) {
      return deniedLicense(license, "license does not include inference:complete");
    }
    return {
      allowed: true,
      accountId,
      licenseId: license.id,
      planId: license.planId,
      entitlements: license.entitlements,
      reason: "license entitlement permits inference",
    };
  }
}

function deniedLicense(
  license: LicenseRecord,
  reason: string,
): {
  readonly allowed: false;
  readonly accountId: string;
  readonly licenseId: string;
  readonly planId: string;
  readonly entitlements: readonly string[];
  readonly reason: string;
} {
  return {
    allowed: false,
    accountId: license.accountId,
    licenseId: license.id,
    planId: license.planId,
    entitlements: license.entitlements,
    reason,
  };
}

function parseCompletionRequest(body: unknown): CompletionRequest {
  const input = parseGatewayCompletionRequest(body);
  if (input.request !== undefined) return input.request;
  if (input.prompt !== undefined) {
    return {
      system: "You are the local deterministic Reef gateway model.",
      messages: [{ role: "user", content: input.prompt }],
      tools: [],
      maxTokens: 256,
    };
  }
  throw new Error("request or prompt is required");
}

function parseGatewayCompletionRequest(body: unknown): GatewayCompletionRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("JSON object body is required");
  }
  const raw = body as Record<string, unknown>;
  const prompt = typeof raw.prompt === "string" && raw.prompt.trim() !== "" ? raw.prompt : undefined;
  const model = typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model : undefined;
  const request =
    raw.request !== undefined ? coerceCompletionRequest(raw.request) : undefined;
  return {
    ...(request !== undefined ? { request } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function coerceCompletionRequest(value: unknown): CompletionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request must be an object");
  }
  const raw = value as Partial<CompletionRequest>;
  if (
    typeof raw.system !== "string" ||
    !Array.isArray(raw.messages) ||
    !Array.isArray(raw.tools) ||
    typeof raw.maxTokens !== "number" ||
    raw.maxTokens <= 0
  ) {
    throw new Error("request is not a valid completion request");
  }
  return raw as CompletionRequest;
}

function modelFromRequest(body: unknown): string | undefined {
  return body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof (body as { model?: unknown }).model === "string"
    ? (body as { model: string }).model
    : undefined;
}

function normalizeUsage(
  usage: ModelUsage | undefined,
  provider: string,
): ModelUsage {
  if (usage !== undefined) {
    return {
      provider: usage.provider,
      model: usage.model,
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
        : {}),
      ...(usage.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: usage.cacheReadInputTokens }
        : {}),
      totalTokens:
        usage.totalTokens ??
        (usage.inputTokens ?? 0) +
          (usage.outputTokens ?? 0) +
          (usage.cacheCreationInputTokens ?? 0) +
          (usage.cacheReadInputTokens ?? 0),
    };
  }
  return {
    provider,
    model: "unknown",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
