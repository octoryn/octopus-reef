import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GatewayControlPlane,
  GatewayHttpServer,
  SqliteGatewayDb,
  loadGatewayConfig,
} from "../src/index.js";

test("G2: quota is honest, debited, billing-ledgered, and enforced fail-closed", async () => {
  const db = new SqliteGatewayDb(":memory:");
  const config = loadGatewayConfig({
    REEF_GATEWAY_DB_URL: "sqlite::memory:",
    REEF_GATEWAY_ADMIN_TOKEN: "local-g2-admin",
    REEF_GATEWAY_JWT_SECRET: "local-g2-jwt-secret",
    REEF_GATEWAY_LEDGER_SECRET: "local-g2-ledger-secret",
    REEF_GATEWAY_DEFAULT_QUOTA_TOKENS: "1000",
  });
  const control = new GatewayControlPlane({ config, db });
  const server = new GatewayHttpServer(control);
  const port = await server.listen(0, "127.0.0.1");
  try {
    const provisioned = await fetchJson(port, "POST", "/v1/admin/accounts", {
      token: "local-g2-admin",
      body: { email: "quota@example.test" },
    });
    assert.equal(provisioned.status, 201);
    const accountId = String(provisioned.body.accountId);
    const token = String(provisioned.body.accessToken);

    const initialQuota = await fetchJson(port, "GET", "/v1/quota", {
      token,
    });
    assert.equal(initialQuota.status, 200);
    assert.equal(initialQuota.body.source, "gateway-db-quota-ledger");
    assert.equal(initialQuota.body.usedTokens, 0);
    assert.equal(initialQuota.body.remainingTokens, 1000);

    const completion = await fetchJson(port, "POST", "/v1/complete", {
      token,
      body: {
        request: {
          system: "local quota test",
          messages: [{ role: "user", content: "spend quota honestly" }],
          tools: [],
          maxTokens: 64,
        },
      },
    });
    assert.equal(completion.status, 200);
    const usage = completion.body.usage as { readonly totalTokens?: number };
    const totalTokens = usage.totalTokens ?? 0;
    assert.ok(totalTokens > 0);
    const evidence = completion.body.evidence as Record<string, string>;
    assert.match(evidence.quota, /^ev_[a-f0-9]{64}$/);

    const afterQuota = await fetchJson(port, "GET", "/v1/quota", { token });
    assert.equal(afterQuota.status, 200);
    assert.equal(afterQuota.body.usedTokens, totalTokens);
    assert.equal(afterQuota.body.remainingTokens, 1000 - totalTokens);
    assert.ok(Number(afterQuota.body.costUsd) > 0);
    assert.equal(await db.sumUsageForAccount(accountId), totalTokens);
    assert.equal(
      await db.sumCostForAccount(accountId),
      afterQuota.body.costUsd,
    );
    assert.equal(
      await db.sumBillingForAccount(accountId),
      afterQuota.body.costUsd,
    );

    await db.upsertQuota({
      accountId,
      limitTokens: totalTokens,
      usedTokens: totalTokens,
      updatedAt: new Date().toISOString(),
    });
    const routeCountBefore = (await db.listLedgerRecords()).filter(
      (record) => record.evidence.kind === "reef.gateway.route",
    ).length;
    const denied = await fetchJson(port, "POST", "/v1/complete", {
      token,
      body: {
        request: {
          system: "local quota test",
          messages: [{ role: "user", content: "over quota" }],
          tools: [],
          maxTokens: 1,
        },
      },
    });
    assert.equal(denied.status, 403);
    assert.match(String(denied.body.evidenceId), /^ev_[a-f0-9]{64}$/);
    const records = await db.listLedgerRecords();
    assert.equal(
      records.filter((record) => record.evidence.kind === "reef.gateway.route")
        .length,
      routeCountBefore,
      "over-quota requests must not route to a model provider",
    );
    assert.ok(
      records.some(
        (record) =>
          record.evidence.kind === "reef.gateway.quota" &&
          (record.evidence.content as { allowed?: boolean }).allowed === false,
      ),
      "over-quota denial should be evidence-backed",
    );
  } finally {
    await server.close();
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
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  return { status: res.status, body: (await res.json()) as JsonObject };
}

type JsonObject = { readonly [key: string]: unknown };
