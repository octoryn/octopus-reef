import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayProvider } from "../../commercial/src/index.js";
import { startStubIdentityProvider } from "@octopus-reef/commercial/stub-identity";
import {
  GatewayControlPlane,
  GatewayHttpServer,
  SqliteGatewayDb,
  loadGatewayConfig,
} from "../src/index.js";

test("G6: commercial client reaches real gateway with SSO team priority and tamper-red verify", async () => {
  const idp = await startStubIdentityProvider({
    userId: "editor-g6-user",
    displayName: "Editor G6 User",
  });
  const db = new SqliteGatewayDb(":memory:");
  const config = loadGatewayConfig({
    REEF_GATEWAY_DB_URL: "sqlite::memory:",
    REEF_GATEWAY_JWT_SECRET: "local-g6-jwt-secret",
    REEF_GATEWAY_LEDGER_SECRET: "local-g6-ledger-secret",
  });
  const control = new GatewayControlPlane({ config, db });
  const server = new GatewayHttpServer(control);
  const port = await server.listen(0, "127.0.0.1");
  const gatewayUrl = `http://127.0.0.1:${port}`;
  try {
    const sso = await fetchJson(port, "POST", "/v1/sso/login", {
      body: { issuer: idp.issuer },
    });
    assert.equal(sso.status, 200);
    const accessToken = String(sso.body.accessToken);
    const provider = new GatewayProvider({
      gatewayUrl,
      accessToken,
      priorityTier: "priority",
    });
    const completion = await provider.complete({
      system: "editor commercial gateway test",
      messages: [
        {
          role: "user",
          content: "Run the real Reef control plane path.",
        },
      ],
      tools: [],
      maxTokens: 64,
    });
    assert.equal(completion.stopReason, "end_turn");
    assert.ok((completion.usage?.totalTokens ?? 0) > 0);

    const quota = await fetchJson(port, "GET", "/v1/quota", {
      token: accessToken,
    });
    assert.equal(quota.status, 200);
    assert.ok(Number(quota.body.usedTokens) > 0);
    assert.equal(quota.body.source, "gateway-db-quota-ledger");

    const audit = await fetchJson(port, "GET", "/v1/team/audit", {
      token: accessToken,
    });
    assert.equal(audit.status, 200);
    assert.equal(audit.body.teamId, "reef-local-team");
    const auditUsage = audit.body.usage as { readonly totalTokens?: number };
    assert.ok((auditUsage.totalTokens ?? 0) >= (completion.usage?.totalTokens ?? 0));

    const plan = await fetchJson(port, "GET", "/v1/plan?tier=priority", {
      token: accessToken,
    });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.selectedTier, "priority");

    const green = await fetchJson(port, "GET", "/v1/verify");
    assert.equal(green.status, 200);
    assert.equal(green.body.ok, true);

    const tier = (await db.listLedgerRecords()).find(
      (record) =>
        record.evidence.kind === "reef.gateway.tier" &&
        (record.evidence.content as { tier?: string }).tier === "priority",
    );
    assert.ok(tier, "priority tier evidence should exist");
    db.tamperLedgerEvidenceForTests(tier.sequence, "Priority", "Prioritz");
    const red = await fetchJson(port, "GET", "/v1/verify");
    assert.equal(red.status, 200);
    assert.equal(red.body.ok, false);
    assert.match(String(red.body.reason), /integrity/i);
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
