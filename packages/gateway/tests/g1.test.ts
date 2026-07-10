import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GatewayControlPlane,
  GatewayHttpServer,
  SqliteGatewayDb,
  loadGatewayConfig,
} from "../src/index.js";

test("G1: authenticated completion routes through entitlement, provider, metering, and evidence", async () => {
  const db = new SqliteGatewayDb(":memory:");
  const config = loadGatewayConfig({
    REEF_GATEWAY_DB_URL: "sqlite::memory:",
    REEF_GATEWAY_ADMIN_TOKEN: "local-g1-admin",
    REEF_GATEWAY_JWT_SECRET: "local-g1-jwt-secret",
    REEF_GATEWAY_LEDGER_SECRET: "local-g1-ledger-secret",
  });
  const control = new GatewayControlPlane({ config, db });
  const server = new GatewayHttpServer(control);
  const port = await server.listen(0, "127.0.0.1");
  try {
    const provisioned = await fetchJson(port, "POST", "/v1/admin/accounts", {
      token: "local-g1-admin",
      body: {
        email: "entitled@example.test",
        displayName: "Entitled User",
      },
    });
    assert.equal(provisioned.status, 201);
    const accountId = String(provisioned.body.accountId);
    const accessToken = String(provisioned.body.accessToken);
    assert.match(accessToken, /^[^.]+\.[^.]+\.[^.]+$/);

    const completion = await fetchJson(port, "POST", "/v1/complete", {
      token: accessToken,
      body: { prompt: "Summarize why verifiable control planes matter." },
    });
    assert.equal(completion.status, 200);
    assert.equal(completion.body.stopReason, "end_turn");
    const usage = completion.body.usage as {
      readonly totalTokens?: number;
      readonly provider?: string;
    };
    assert.equal(usage.provider, "reef-gateway-local");
    assert.ok((usage.totalTokens ?? 0) > 0);
    assert.equal(
      await db.sumUsageForAccount(accountId),
      usage.totalTokens,
      "provider usage should be persisted to the usage ledger",
    );
    const evidence = completion.body.evidence as Record<string, string>;
    assert.match(evidence.auth, /^ev_[a-f0-9]{64}$/);
    assert.match(evidence.entitlement, /^ev_[a-f0-9]{64}$/);
    assert.match(evidence.route, /^ev_[a-f0-9]{64}$/);
    assert.match(evidence.meter, /^ev_[a-f0-9]{64}$/);

    const unentitled = await fetchJson(port, "POST", "/v1/admin/accounts", {
      token: "local-g1-admin",
      body: {
        email: "unentitled@example.test",
        displayName: "Unentitled User",
        entitlements: [],
      },
    });
    assert.equal(unentitled.status, 201);
    const denied = await fetchJson(port, "POST", "/v1/complete", {
      token: String(unentitled.body.accessToken),
      body: { prompt: "This should not route." },
    });
    assert.equal(denied.status, 403);
    assert.match(String(denied.body.evidenceId), /^ev_[a-f0-9]{64}$/);

    const invalid = await fetchJson(port, "POST", "/v1/complete", {
      token: "not-a-jwt",
      body: { prompt: "This should fail auth." },
    });
    assert.equal(invalid.status, 401);
    assert.match(String(invalid.body.evidenceId), /^ev_[a-f0-9]{64}$/);

    const records = await db.listLedgerRecords();
    const kinds = records.map((record) => record.evidence.kind);
    assert.ok(kinds.includes("reef.gateway.auth"));
    assert.ok(kinds.includes("reef.gateway.entitlement"));
    assert.ok(kinds.includes("reef.gateway.route"));
    assert.ok(kinds.includes("reef.gateway.meter"));
    assert.ok(
      records.some(
        (record) =>
          record.evidence.kind === "reef.gateway.entitlement" &&
          (record.evidence.content as { allowed?: boolean }).allowed === false,
      ),
      "unentitled denial should be evidence-backed",
    );
    assert.ok(
      records.some(
        (record) =>
          record.evidence.kind === "reef.gateway.auth" &&
          (record.evidence.content as { allowed?: boolean }).allowed === false,
      ),
      "invalid token denial should be evidence-backed",
    );

    const verify = await fetchJson(port, "GET", "/v1/verify");
    assert.equal(verify.status, 200);
    assert.equal(verify.body.ok, true);
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
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as JsonObject };
}

type JsonObject = { readonly [key: string]: unknown };
