import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import {
  bearerToken,
  hashSecret,
  issueAccessToken,
  localPasswordMaterial,
  passwordMaterial,
  randomOpaqueToken,
  verifyAccessToken,
  verifyPassword,
} from "./auth.js";
import { signInWithStubOidc } from "@octopus-reef/commercial";
import { createBillingAdapter } from "./billing.js";
import { CompletionService, priorityDecision } from "./completion.js";
import type { GatewayDb } from "./db.js";
import { GatewayLedger } from "./ledger.js";
import { createGatewayModelProvider } from "./provider.js";
import type {
  GatewayCompletionResponse,
  GatewayConfig,
  GatewayDecisionInput,
  GatewayDecisionRecord,
  GatewayErrorBody,
  GatewayPlanResponse,
  GatewayQuotaResponse,
  LoginRequest,
  LoginResponse,
  ProvisionAccountRequest,
  ProvisionAccountResponse,
  RevokeLicenseResponse,
  SignupRequest,
  SsoLoginRequest,
  SsoLoginResponse,
  TeamAuditResponse,
  GatewayVerifyResult,
} from "./types.js";

export interface GatewayControlPlaneOptions {
  readonly config: GatewayConfig;
  readonly db: GatewayDb;
}

export class GatewayControlPlane {
  readonly config: GatewayConfig;
  readonly db: GatewayDb;
  readonly ledger: GatewayLedger;
  readonly #completion: CompletionService;

  constructor(options: GatewayControlPlaneOptions) {
    this.config = options.config;
    this.db = options.db;
    this.ledger = new GatewayLedger({
      db: options.db,
      ...(options.config.ledgerSecret !== undefined
        ? { integritySecret: options.config.ledgerSecret }
        : {}),
    });
    this.#completion = new CompletionService({
      config: options.config,
      db: options.db,
      ledger: this.ledger,
      provider: createGatewayModelProvider(options.config),
      billing: createBillingAdapter(options.config, options.db),
    });
  }

  async start(): Promise<void> {
    await this.db.migrate();
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  recordDecision(input: GatewayDecisionInput): Promise<GatewayDecisionRecord> {
    return this.ledger.appendDecision(input);
  }

  verify(): Promise<GatewayVerifyResult> {
    return this.ledger.verify();
  }

  async provisionAccount(
    request: ProvisionAccountRequest,
  ): Promise<ProvisionAccountResponse> {
    const email = request.email.trim().toLowerCase();
    if (email === "" || !email.includes("@")) {
      throw new HttpError(400, "valid email is required");
    }
    const existing = await this.db.getAccountByEmail(email);
    const accountId = existing?.id ?? randomUUID();
    const displayName =
      clean(request.displayName) ?? existing?.displayName ?? email;
    const material =
      existing === undefined
        ? localPasswordMaterial(email)
        : {
            salt: existing.passwordSalt,
            hash: existing.passwordHash,
          };
    const now = new Date().toISOString();
    await this.db.upsertAccount({
      id: accountId,
      email,
      displayName,
      passwordSalt: material.salt,
      passwordHash: material.hash,
      status: "active",
      ...(existing?.teamId !== undefined ? { teamId: existing.teamId } : {}),
      createdAt: existing?.createdAt ?? now,
    });
    const licenseToken = randomOpaqueToken("reef_license");
    const entitlements =
      request.entitlements === undefined
        ? ["inference:complete"]
        : request.entitlements;
    const planId = clean(request.planId) ?? "reef-commercial-local";
    await this.db.upsertLicense({
      id: randomUUID(),
      accountId,
      tokenHash: hashSecret(licenseToken),
      planId,
      status: "active",
      entitlements,
      createdAt: now,
    });
    await this.db.upsertQuota({
      accountId,
      limitTokens: this.config.defaultQuotaTokens,
      usedTokens: await this.db.sumUsageForAccount(accountId),
      updatedAt: now,
    });
    const evidence = await this.recordDecision({
      decision: "license.provision",
      method: "admin",
      tenantId: accountId,
      accountId,
      actorId: "admin",
      content: jsonValue({
        allowed: true,
        accountId,
        email,
        planId,
        entitlements,
      }),
    });
    return {
      accountId,
      email,
      displayName,
      planId,
      entitlements,
      accessToken: issueAccessToken(this.config, {
        accountId,
        tenantId: accountId,
        email,
      }),
      licenseToken,
      evidenceId: evidence.evidenceId,
    };
  }

  async signup(request: SignupRequest): Promise<ProvisionAccountResponse> {
    const email = request.email.trim().toLowerCase();
    if (email === "" || !email.includes("@")) {
      throw new HttpError(400, "valid email is required");
    }
    if (request.password.length < 8) {
      throw new HttpError(400, "password must be at least 8 characters");
    }
    const existing = await this.db.getAccountByEmail(email);
    if (existing !== undefined)
      throw new HttpError(409, "account already exists");

    const accountId = randomUUID();
    const displayName = clean(request.displayName) ?? email;
    const material = passwordMaterial(request.password);
    const now = new Date().toISOString();
    await this.db.upsertAccount({
      id: accountId,
      email,
      displayName,
      passwordSalt: material.salt,
      passwordHash: material.hash,
      status: "active",
      createdAt: now,
    });
    const signupEvidence = await this.recordDecision({
      decision: "account.signup",
      method: "password",
      tenantId: accountId,
      accountId,
      actorId: accountId,
      content: jsonValue({
        allowed: true,
        accountId,
        email,
      }),
    });

    const licenseToken = randomOpaqueToken("reef_license");
    const entitlements = ["inference:complete"];
    const planId = "reef-commercial-local";
    await this.db.upsertLicense({
      id: randomUUID(),
      accountId,
      tokenHash: hashSecret(licenseToken),
      planId,
      status: "active",
      entitlements,
      createdAt: now,
    });
    await this.db.upsertQuota({
      accountId,
      limitTokens: this.config.defaultQuotaTokens,
      usedTokens: 0,
      updatedAt: now,
    });
    await this.recordDecision({
      decision: "license.provision",
      method: "signup",
      tenantId: accountId,
      accountId,
      actorId: accountId,
      content: jsonValue({
        allowed: true,
        accountId,
        email,
        planId,
        entitlements,
      }),
    });

    return {
      accountId,
      email,
      displayName,
      planId,
      entitlements,
      accessToken: issueAccessToken(this.config, {
        accountId,
        tenantId: accountId,
        email,
      }),
      licenseToken,
      evidenceId: signupEvidence.evidenceId,
    };
  }

  async login(request: LoginRequest): Promise<
    | { readonly ok: true; readonly status: 200; readonly body: LoginResponse }
    | {
        readonly ok: false;
        readonly status: 401;
        readonly body: GatewayErrorBody;
      }
  > {
    const email = request.email.trim().toLowerCase();
    const account = await this.db.getAccountByEmail(email);
    const allowed =
      account !== undefined &&
      account.status === "active" &&
      verifyPassword(
        request.password,
        account.passwordSalt,
        account.passwordHash,
      );
    const evidence = await this.recordDecision({
      decision: "auth",
      method: "password",
      ...(account !== undefined
        ? {
            tenantId: account.id,
            accountId: account.id,
            actorId: account.id,
          }
        : {}),
      content: {
        allowed,
        email,
        reason: allowed ? "password verified" : "invalid email or password",
      },
    });
    if (!allowed || account === undefined) {
      return {
        ok: false,
        status: 401,
        body: { error: "login denied", evidenceId: evidence.evidenceId },
      };
    }
    return {
      ok: true,
      status: 200,
      body: {
        accountId: account.id,
        email: account.email,
        displayName: account.displayName,
        accessToken: issueAccessToken(this.config, {
          accountId: account.id,
          tenantId: account.id,
          email: account.email,
        }),
        evidenceId: evidence.evidenceId,
      },
    };
  }

  async revokeLicense(authHeader: string | undefined): Promise<
    | {
        readonly ok: true;
        readonly status: 200;
        readonly body: RevokeLicenseResponse;
      }
    | {
        readonly ok: false;
        readonly status: 401;
        readonly body: GatewayErrorBody;
      }
  > {
    const token = bearerToken(authHeader);
    const verified =
      token === undefined
        ? ({ ok: false, reason: "missing bearer token" } as const)
        : verifyAccessToken(token, this.config);
    const authEvidence = await this.ledger.appendDecision({
      decision: "auth",
      method: "jwt",
      ...(verified.ok
        ? {
            tenantId: verified.principal.tenantId,
            accountId: verified.principal.accountId,
            actorId: verified.principal.accountId,
          }
        : {}),
      content: {
        allowed: verified.ok,
        reason: verified.ok ? "signed JWT verified" : verified.reason,
      },
    });
    if (!verified.ok) {
      return {
        ok: false,
        status: 401,
        body: { error: "auth denied", evidenceId: authEvidence.evidenceId },
      };
    }
    const now = new Date().toISOString();
    await this.db.revokeLicense(verified.principal.accountId, now);
    const revokeEvidence = await this.recordDecision({
      decision: "license.revoke",
      method: "account",
      tenantId: verified.principal.tenantId,
      accountId: verified.principal.accountId,
      actorId: verified.principal.accountId,
      content: {
        allowed: true,
        accountId: verified.principal.accountId,
        revokedAt: now,
      },
    });
    return {
      ok: true,
      status: 200,
      body: {
        accountId: verified.principal.accountId,
        revoked: true,
        evidence: {
          auth: authEvidence.evidenceId,
          revoke: revokeEvidence.evidenceId,
        },
      },
    };
  }

  async ssoLogin(request: SsoLoginRequest): Promise<SsoLoginResponse> {
    const issuer = request.issuer ?? this.config.oidcIssuer;
    const identity = await signInWithStubOidc(
      issuer === undefined ? {} : { issuer },
    );
    const accountId = identity.userId;
    const email = `${identity.userId}@oidc.local`;
    const now = new Date().toISOString();
    const existing = await this.db.getAccount(accountId);
    const material =
      existing === undefined
        ? localPasswordMaterial(identity.userId)
        : {
            salt: existing.passwordSalt,
            hash: existing.passwordHash,
          };
    await this.db.upsertAccount({
      id: accountId,
      email,
      displayName: identity.displayName,
      passwordSalt: material.salt,
      passwordHash: material.hash,
      status: "active",
      teamId: identity.team.id,
      createdAt: existing?.createdAt ?? now,
    });
    await this.db.upsertTeam({
      id: identity.team.id,
      name: identity.team.name,
      createdAt: now,
    });
    for (const member of identity.team.members) {
      const memberEmail = `${member.userId}@oidc.local`;
      const memberExisting = await this.db.getAccount(member.userId);
      const memberMaterial =
        memberExisting === undefined
          ? localPasswordMaterial(member.userId)
          : {
              salt: memberExisting.passwordSalt,
              hash: memberExisting.passwordHash,
            };
      await this.db.upsertAccount({
        id: member.userId,
        email: memberEmail,
        displayName: member.displayName,
        passwordSalt: memberMaterial.salt,
        passwordHash: memberMaterial.hash,
        status: "active",
        teamId: identity.team.id,
        createdAt: memberExisting?.createdAt ?? now,
      });
      await this.db.upsertTeamMember({
        teamId: identity.team.id,
        accountId: member.userId,
        role: member.role,
        createdAt: now,
      });
    }
    await this.db.upsertLicense({
      id: randomUUID(),
      accountId,
      tokenHash: hashSecret(identity.licenseToken),
      planId: "reef-commercial-priority-sso",
      status: "active",
      entitlements: ["inference:complete", "team:audit", "priority:route"],
      createdAt: now,
    });
    await this.db.upsertQuota({
      accountId,
      limitTokens: this.config.defaultQuotaTokens,
      usedTokens: await this.db.sumUsageForAccount(accountId),
      updatedAt: now,
    });
    const ssoEvidence = await this.recordDecision({
      decision: "sso",
      method: "oidc-code-flow",
      tenantId: identity.team.id,
      accountId,
      actorId: accountId,
      content: jsonValue({
        allowed: true,
        marker: "OIDC SSO entitlement",
        issuer: identity.issuer,
        subject: identity.subject,
        source: identity.source,
      }),
    });
    const teamEvidence = await this.recordDecision({
      decision: "team",
      method: "oidc-claims",
      tenantId: identity.team.id,
      accountId,
      actorId: accountId,
      content: jsonValue({
        allowed: true,
        team: identity.team,
      }),
    });
    return {
      accountId,
      accessToken: issueAccessToken(this.config, {
        accountId,
        tenantId: identity.team.id,
        email,
      }),
      sso: {
        issuer: identity.issuer,
        subject: identity.subject,
        userId: identity.userId,
        displayName: identity.displayName,
      },
      team: {
        id: identity.team.id,
        name: identity.team.name,
        role: identity.team.role,
        members: identity.team.members.map((member) => ({
          accountId: member.userId,
          displayName: member.displayName,
          role: member.role,
        })),
      },
      evidence: {
        sso: ssoEvidence.evidenceId,
        team: teamEvidence.evidenceId,
      },
    };
  }

  async teamAudit(authHeader: string | undefined): Promise<
    | {
        readonly ok: true;
        readonly status: 200;
        readonly body: TeamAuditResponse;
      }
    | {
        readonly ok: false;
        readonly status: 401 | 403;
        readonly body: GatewayErrorBody;
      }
  > {
    const token = bearerToken(authHeader);
    const verified =
      token === undefined
        ? ({ ok: false, reason: "missing bearer token" } as const)
        : verifyAccessToken(token, this.config);
    const authEvidence = await this.ledger.appendDecision({
      decision: "auth",
      method: "jwt",
      ...(verified.ok
        ? {
            tenantId: verified.principal.tenantId,
            accountId: verified.principal.accountId,
            actorId: verified.principal.accountId,
          }
        : {}),
      content: {
        allowed: verified.ok,
        reason: verified.ok ? "signed JWT verified" : verified.reason,
      },
    });
    if (!verified.ok) {
      return {
        ok: false,
        status: 401,
        body: { error: "auth denied", evidenceId: authEvidence.evidenceId },
      };
    }
    const membership = await this.db.getTeamForAccount(
      verified.principal.accountId,
    );
    if (membership === undefined) {
      const denied = await this.recordDecision({
        decision: "team.audit",
        method: "membership",
        tenantId: verified.principal.tenantId,
        accountId: verified.principal.accountId,
        actorId: verified.principal.accountId,
        content: {
          allowed: false,
          reason: "account is not a team member",
        },
      });
      return {
        ok: false,
        status: 403,
        body: {
          error: "team membership denied",
          evidenceId: denied.evidenceId,
        },
      };
    }
    const members = await this.db.listTeamMembers(membership.team.id);
    const usageMembers = await Promise.all(
      members.map(async (member) => ({
        accountId: member.accountId,
        displayName: member.displayName,
        role: member.role,
        usedTokens: await this.db.sumUsageForAccount(member.accountId),
      })),
    );
    const totalTokens = usageMembers.reduce(
      (sum, member) => sum + member.usedTokens,
      0,
    );
    const auditEvidence = await this.recordDecision({
      decision: "team.audit",
      method: "membership",
      tenantId: membership.team.id,
      accountId: verified.principal.accountId,
      actorId: verified.principal.accountId,
      content: jsonValue({
        allowed: true,
        teamId: membership.team.id,
        role: membership.member.role,
        totalTokens,
        members: usageMembers,
      }),
    });
    return {
      ok: true,
      status: 200,
      body: {
        teamId: membership.team.id,
        teamName: membership.team.name,
        role: membership.member.role,
        usage: {
          totalTokens,
          members: usageMembers,
        },
        evidence: {
          auth: authEvidence.evidenceId,
          audit: auditEvidence.evidenceId,
        },
      },
    };
  }

  complete(
    authHeader: string | undefined,
    body: unknown,
  ): Promise<
    | {
        readonly ok: true;
        readonly status: 200;
        readonly body: GatewayCompletionResponse;
      }
    | {
        readonly ok: false;
        readonly status: 400 | 401 | 403 | 502;
        readonly body: GatewayErrorBody;
      }
  > {
    const token = bearerToken(authHeader);
    const principal =
      token === undefined
        ? ({ ok: false, reason: "missing bearer token" } as const)
        : verifyAccessToken(token, this.config);
    return this.#completion.complete({
      principal:
        principal.ok === true
          ? { ok: true, value: principal.principal }
          : { ok: false, reason: principal.reason },
      body,
    });
  }

  async quota(authHeader: string | undefined): Promise<
    | {
        readonly ok: true;
        readonly status: 200;
        readonly body: GatewayQuotaResponse;
      }
    | {
        readonly ok: false;
        readonly status: 401 | 403;
        readonly body: GatewayErrorBody;
      }
  > {
    const token = bearerToken(authHeader);
    const verified =
      token === undefined
        ? ({ ok: false, reason: "missing bearer token" } as const)
        : verifyAccessToken(token, this.config);
    const authEvidence = await this.ledger.appendDecision({
      decision: "auth",
      method: "jwt",
      ...(verified.ok
        ? {
            tenantId: verified.principal.tenantId,
            accountId: verified.principal.accountId,
            actorId: verified.principal.accountId,
          }
        : {}),
      content: {
        allowed: verified.ok,
        reason: verified.ok ? "signed JWT verified" : verified.reason,
      },
    });
    if (!verified.ok) {
      return {
        ok: false,
        status: 401,
        body: { error: "auth denied", evidenceId: authEvidence.evidenceId },
      };
    }
    const principal = verified.principal;
    const license = await this.db.getActiveLicenseByAccount(
      principal.accountId,
    );
    const quota = await this.db.getQuota(principal.accountId);
    const costUsd = await this.db.sumCostForAccount(principal.accountId);
    const allowed = license !== undefined && quota !== undefined;
    const quotaEvidence = await this.ledger.appendDecision({
      decision: "quota",
      method: "db-quota-ledger",
      tenantId: principal.tenantId,
      accountId: principal.accountId,
      actorId: principal.accountId,
      content: jsonValue({
        allowed,
        accountId: principal.accountId,
        planId: license?.planId,
        limitTokens: quota?.limitTokens,
        usedTokens: quota?.usedTokens,
        remainingTokens:
          quota === undefined
            ? undefined
            : Math.max(0, quota.limitTokens - quota.usedTokens),
        costUsd,
        source: "gateway-db-quota-ledger",
        reason: allowed
          ? "quota read from gateway DB ledger"
          : "license or quota ledger is missing; failing closed",
      }),
    });
    if (!allowed || quota === undefined || license === undefined) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "quota unavailable",
          evidenceId: quotaEvidence.evidenceId,
        },
      };
    }
    return {
      ok: true,
      status: 200,
      body: {
        accountId: principal.accountId,
        planId: license.planId,
        usedTokens: quota.usedTokens,
        remainingTokens: Math.max(0, quota.limitTokens - quota.usedTokens),
        limitTokens: quota.limitTokens,
        costUsd,
        source: "gateway-db-quota-ledger",
        evidence: {
          auth: authEvidence.evidenceId,
          quota: quotaEvidence.evidenceId,
        },
      },
    };
  }

  async plan(
    authHeader: string | undefined,
    requestedTier: "standard" | "priority",
  ): Promise<
    | {
        readonly ok: true;
        readonly status: 200;
        readonly body: GatewayPlanResponse;
      }
    | {
        readonly ok: false;
        readonly status: 401 | 403;
        readonly body: GatewayErrorBody;
      }
  > {
    const token = bearerToken(authHeader);
    const verified =
      token === undefined
        ? ({ ok: false, reason: "missing bearer token" } as const)
        : verifyAccessToken(token, this.config);
    const authEvidence = await this.ledger.appendDecision({
      decision: "auth",
      method: "jwt",
      ...(verified.ok
        ? {
            tenantId: verified.principal.tenantId,
            accountId: verified.principal.accountId,
            actorId: verified.principal.accountId,
          }
        : {}),
      content: {
        allowed: verified.ok,
        reason: verified.ok ? "signed JWT verified" : verified.reason,
      },
    });
    if (!verified.ok) {
      return {
        ok: false,
        status: 401,
        body: { error: "auth denied", evidenceId: authEvidence.evidenceId },
      };
    }
    const license = await this.db.getActiveLicenseByAccount(
      verified.principal.accountId,
    );
    if (license === undefined) {
      const denied = await this.recordDecision({
        decision: "tier",
        method: "plan-policy",
        tenantId: verified.principal.tenantId,
        accountId: verified.principal.accountId,
        actorId: verified.principal.accountId,
        content: {
          allowed: false,
          requestedTier,
          reason: "active license is missing",
        },
      });
      return {
        ok: false,
        status: 403,
        body: {
          error: "active license is missing",
          evidenceId: denied.evidenceId,
        },
      };
    }
    const selected = priorityDecision(
      requestedTier,
      {
        allowed: true,
        planId: license.planId,
        entitlements: license.entitlements,
      },
      undefined,
    );
    const tierEvidence = await this.recordDecision({
      decision: "tier",
      method: "plan-policy",
      tenantId: verified.principal.tenantId,
      accountId: verified.principal.accountId,
      actorId: verified.principal.accountId,
      content: jsonValue(selected),
    });
    const priorityAllowed =
      license.entitlements.includes("priority:route") ||
      license.planId.includes("priority");
    return {
      ok: true,
      status: 200,
      body: {
        planId: license.planId,
        selectedTier: selected.allowed ? selected.tier : "standard",
        source: "gateway-plan",
        serviceLevel: selected.serviceLevel,
        tiers: [
          {
            id: "standard",
            label: "Standard gateway",
            queue: "standard",
            model: "reef-gateway-standard-local",
            allowed: true,
          },
          {
            id: "priority",
            label: "Priority gateway",
            queue: "priority",
            model: "reef-gateway-priority-local",
            allowed: priorityAllowed,
          },
        ],
        evidence: {
          auth: authEvidence.evidenceId,
          tier: tierEvidence.evidenceId,
        },
      },
    };
  }
}

export class GatewayHttpServer {
  readonly #control: GatewayControlPlane;
  readonly #server: Server;

  constructor(control: GatewayControlPlane) {
    this.#control = control;
    this.#server = createServer((req, res) => {
      void this.#route(req, res).catch((error: unknown) => {
        respondJson(res, statusOf(error), { error: messageOf(error) });
      });
    });
  }

  async listen(
    port = this.#control.config.port,
    host = this.#control.config.host,
  ): Promise<number> {
    await this.#control.start();
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        const address = this.#server.address();
        resolve(
          typeof address === "object" && address !== null ? address.port : port,
        );
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    await this.#control.close();
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      return respondJson(res, 200, {
        ok: true,
        service: "reef-gateway",
        jwtSecretSource: this.#control.config.jwtSecretSource,
      });
    }
    if (req.method === "GET" && url.pathname === "/ready") {
      const verify = await this.#control.verify();
      return respondJson(res, verify.ok ? 200 : 503, {
        ok: verify.ok,
        db: true,
        ledger: verify,
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/verify") {
      const verify = await this.#control.verify();
      return respondJson(res, 200, verify);
    }
    if (req.method === "POST" && url.pathname === "/v1/admin/decisions") {
      const denied = this.#requireAdmin(req);
      if (denied !== undefined) return respondJson(res, 403, denied);
      const body = await readJson(req);
      const decision = parseDecision(body);
      const record = await this.#control.recordDecision(decision);
      return respondJson(res, 201, record);
    }
    if (req.method === "POST" && url.pathname === "/v1/admin/accounts") {
      const denied = this.#requireAdmin(req);
      if (denied !== undefined) return respondJson(res, 403, denied);
      const body = parseProvisionAccount(await readJson(req));
      const provisioned = await this.#control.provisionAccount(body);
      return respondJson(res, 201, provisioned);
    }
    if (req.method === "POST" && url.pathname === "/v1/signup") {
      const signup = await this.#control.signup(
        parseSignup(await readJson(req)),
      );
      return respondJson(res, 201, signup);
    }
    if (req.method === "POST" && url.pathname === "/v1/login") {
      const login = await this.#control.login(parseLogin(await readJson(req)));
      return respondJson(res, login.status, login.body);
    }
    if (req.method === "POST" && url.pathname === "/v1/license/revoke") {
      const revoked = await this.#control.revokeLicense(
        req.headers.authorization,
      );
      return respondJson(res, revoked.status, revoked.body);
    }
    if (req.method === "POST" && url.pathname === "/v1/sso/login") {
      const login = await this.#control.ssoLogin(
        parseSsoLogin(await readJson(req)),
      );
      return respondJson(res, 200, login);
    }
    if (req.method === "GET" && url.pathname === "/v1/team/audit") {
      const audit = await this.#control.teamAudit(req.headers.authorization);
      return respondJson(res, audit.status, audit.body);
    }
    if (
      req.method === "POST" &&
      (url.pathname === "/v1/complete" || url.pathname === "/v1/completions")
    ) {
      const body = await readJson(req);
      const completed = await this.#control.complete(
        req.headers.authorization,
        body,
      );
      return respondJson(res, completed.status, completed.body);
    }
    if (req.method === "GET" && url.pathname === "/v1/quota") {
      const quota = await this.#control.quota(req.headers.authorization);
      return respondJson(res, quota.status, quota.body);
    }
    if (req.method === "GET" && url.pathname === "/v1/plan") {
      const requestedTier =
        url.searchParams.get("tier") === "priority" ? "priority" : "standard";
      const plan = await this.#control.plan(
        req.headers.authorization,
        requestedTier,
      );
      return respondJson(res, plan.status, plan.body);
    }
    return respondJson(res, 404, { error: "not found" });
  }

  #requireAdmin(req: IncomingMessage): GatewayErrorBody | undefined {
    const configured = this.#control.config.adminToken;
    if (configured === undefined) {
      return { error: "admin endpoints are disabled" };
    }
    return req.headers.authorization === `Bearer ${configured}`
      ? undefined
      : { error: "admin token denied" };
  }
}

function parseSignup(value: unknown): SignupRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "JSON object body is required");
  }
  const body = value as Record<string, unknown>;
  const email = clean(body.email);
  const password = clean(body.password);
  const displayName = clean(body.displayName);
  if (email === undefined) throw new HttpError(400, "email is required");
  if (password === undefined) throw new HttpError(400, "password is required");
  return {
    email,
    password,
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

function parseLogin(value: unknown): LoginRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "JSON object body is required");
  }
  const body = value as Record<string, unknown>;
  const email = clean(body.email);
  const password = clean(body.password);
  if (email === undefined) throw new HttpError(400, "email is required");
  if (password === undefined) throw new HttpError(400, "password is required");
  return { email, password };
}

function parseSsoLogin(value: unknown): SsoLoginRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "JSON object body is required");
  }
  const body = value as Record<string, unknown>;
  const issuer = clean(body.issuer);
  return issuer === undefined ? {} : { issuer };
}

function parseProvisionAccount(value: unknown): ProvisionAccountRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "JSON object body is required");
  }
  const body = value as Record<string, unknown>;
  const email = clean(body.email);
  if (email === undefined) throw new HttpError(400, "email is required");
  const displayName = clean(body.displayName);
  const planId = clean(body.planId);
  const entitlements = Array.isArray(body.entitlements)
    ? body.entitlements.filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;
  return {
    email,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(planId !== undefined ? { planId } : {}),
    ...(entitlements !== undefined ? { entitlements } : {}),
  };
}

function parseDecision(value: unknown): GatewayDecisionInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "JSON object body is required");
  }
  const body = value as Record<string, unknown>;
  const decision = clean(body.decision);
  const method = clean(body.method) ?? "admin";
  const tenantId = clean(body.tenantId);
  const accountId = clean(body.accountId);
  const actorId = clean(body.actorId);
  if (decision === undefined) {
    throw new HttpError(400, "decision is required");
  }
  return {
    decision,
    method,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(actorId !== undefined ? { actorId } : {}),
    content: jsonValue(body.content ?? { note: "admin decision recorded" }),
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 128 * 1024) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw.trim() === "" ? {} : JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function jsonValue(value: unknown): GatewayDecisionInput["content"] {
  return JSON.parse(JSON.stringify(value)) as GatewayDecisionInput["content"];
}

function messageOf(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number {
  return error instanceof HttpError ? error.status : 500;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
