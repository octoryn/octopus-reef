import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GatewayControlPlane,
  GatewayHttpServer,
  SqliteGatewayDb,
  loadGatewayConfig,
} from "../src/index.js";

test("G0: gateway ledger verifies store-untrusting and turns red after one-byte tamper", async () => {
  const db = new SqliteGatewayDb(":memory:");
  const config = loadGatewayConfig({
    REEF_GATEWAY_DB_URL: "sqlite::memory:",
    REEF_GATEWAY_ADMIN_TOKEN: "local-g0-admin",
    REEF_GATEWAY_JWT_SECRET: "local-g0-jwt-secret",
    REEF_GATEWAY_LEDGER_SECRET: "local-g0-ledger-secret",
  });
  const control = new GatewayControlPlane({ config, db });
  const server = new GatewayHttpServer(control);
  const port = await server.listen(0, "127.0.0.1");
  try {
    const health = await fetchJson(port, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const created = await fetchJson(port, "POST", "/v1/admin/decisions", {
      token: "local-g0-admin",
      body: {
        decision: "g0.scaffold",
        tenantId: "tenant-g0",
        actorId: "acceptance",
        content: {
          allowed: true,
          marker: "gateway ledger green marker",
        },
      },
    });
    assert.equal(created.status, 201);
    assert.match(String(created.body.evidenceId), /^ev_[a-f0-9]{64}$/);

    const ready = await fetchJson(port, "GET", "/ready");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.ok, true);
    assert.equal(ready.body.ledger.length, 1);

    const green = await fetchJson(port, "GET", "/v1/verify");
    assert.equal(green.status, 200);
    assert.equal(green.body.ok, true);
    assert.equal(green.body.length, 1);

    db.tamperLedgerEvidenceForTests(0, "green", "greem");
    const red = await fetchJson(port, "GET", "/v1/verify");
    assert.equal(red.status, 200);
    assert.equal(red.body.ok, false);
    assert.match(String(red.body.reason), /integrity/i);
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
