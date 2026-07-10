import assert from "node:assert/strict";
import { test } from "node:test";
import { startStubIdentityProvider } from "@octopus-reef/commercial/stub-identity";
import {
  GatewayControlPlane,
  GatewayHttpServer,
  SqliteGatewayDb,
  loadGatewayConfig,
} from "../src/index.js";

test("G4: local OIDC SSO creates team membership and verifiable team audit", async () => {
  const idp = await startStubIdentityProvider({
    userId: "oidc-g4-user",
    displayName: "OIDC G4 User",
  });
  const db = new SqliteGatewayDb(":memory:");
  const config = loadGatewayConfig({
    REEF_GATEWAY_DB_URL: "sqlite::memory:",
    REEF_GATEWAY_JWT_SECRET: "local-g4-jwt-secret",
    REEF_GATEWAY_LEDGER_SECRET: "local-g4-ledger-secret",
  });
  const control = new GatewayControlPlane({ config, db });
  const server = new GatewayHttpServer(control);
  const port = await server.listen(0, "127.0.0.1");
  try {
    const sso = await fetchJson(port, "POST", "/v1/sso/login", {
      body: { issuer: idp.issuer },
    });
    assert.equal(sso.status, 200);
    const token = String(sso.body.accessToken);
    const team = sso.body.team as {
      readonly id?: string;
      readonly role?: string;
      readonly members?: readonly unknown[];
    };
    assert.equal(team.id, "reef-local-team");
    assert.equal(team.role, "owner");
    assert.ok((team.members?.length ?? 0) >= 2);

    const completion = await fetchJson(port, "POST", "/v1/complete", {
      token,
      body: { prompt: "Team usage should be auditable." },
    });
    assert.equal(completion.status, 200);
    const usage = completion.body.usage as { readonly totalTokens?: number };
    const totalTokens = usage.totalTokens ?? 0;
    assert.ok(totalTokens > 0);

    const audit = await fetchJson(port, "GET", "/v1/team/audit", { token });
    assert.equal(audit.status, 200);
    assert.equal(audit.body.teamId, "reef-local-team");
    assert.equal(audit.body.role, "owner");
    const auditUsage = audit.body.usage as {
      readonly totalTokens?: number;
      readonly members?: readonly unknown[];
    };
    assert.equal(auditUsage.totalTokens, totalTokens);
    assert.ok((auditUsage.members?.length ?? 0) >= 2);
    const auditEvidence = audit.body.evidence as Record<string, string>;
    assert.match(auditEvidence.audit, /^ev_[a-f0-9]{64}$/);

    const signup = await fetchJson(port, "POST", "/v1/signup", {
      body: {
        email: "solo-g4@example.test",
        password: "standalone password",
      },
    });
    assert.equal(signup.status, 201);
    const deniedAudit = await fetchJson(port, "GET", "/v1/team/audit", {
      token: String(signup.body.accessToken),
    });
    assert.equal(deniedAudit.status, 403);
    assert.match(String(deniedAudit.body.evidenceId), /^ev_[a-f0-9]{64}$/);

    const records = await db.listLedgerRecords();
    assert.ok(records.some((record) => record.evidence.kind === "reef.gateway.sso"));
    assert.ok(records.some((record) => record.evidence.kind === "reef.gateway.team"));
    assert.ok(records.some((record) => record.evidence.kind === "reef.gateway.team.audit"));

    const verify = await fetchJson(port, "GET", "/v1/verify");
    assert.equal(verify.status, 200);
    assert.equal(verify.body.ok, true);
  } finally {
    await server.close();
    await idp.close();
  }
});

async function fetchJson(
  port: number,
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown } = {},
): Promise<{ readonly status: number; readonly body: JsonObject }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(options.token !== undefined
        ? { authorization: `Bearer ${options.token}` }
        : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as JsonObject };
}

type JsonObject = { readonly [key: string]: unknown };
