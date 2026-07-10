import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GatewayControlPlane,
  GatewayHttpServer,
  SqliteGatewayDb,
  loadGatewayConfig,
} from "../src/index.js";

test("G5: priority tier routing is plan-gated, evidenced, and honestly reported", async () => {
  const db = new SqliteGatewayDb(":memory:");
  const config = loadGatewayConfig({
    REEF_GATEWAY_DB_URL: "sqlite::memory:",
    REEF_GATEWAY_ADMIN_TOKEN: "local-g5-admin",
    REEF_GATEWAY_JWT_SECRET: "local-g5-jwt-secret",
    REEF_GATEWAY_LEDGER_SECRET: "local-g5-ledger-secret",
  });
  const control = new GatewayControlPlane({ config, db });
  const server = new GatewayHttpServer(control);
  const port = await server.listen(0, "127.0.0.1");
  try {
    const standard = await fetchJson(port, "POST", "/v1/admin/accounts", {
      token: "local-g5-admin",
      body: { email: "standard-g5@example.test" },
    });
    assert.equal(standard.status, 201);
    const standardToken = String(standard.body.accessToken);
    const routeCountBefore = (await db.listLedgerRecords()).filter(
      (record) => record.evidence.kind === "reef.gateway.route",
    ).length;
    const standardDenied = await fetchJson(port, "POST", "/v1/complete", {
      token: standardToken,
      body: {
        prompt: "Try priority on standard.",
        priorityTier: "priority",
      },
    });
    assert.equal(standardDenied.status, 403);
    assert.match(String(standardDenied.body.evidenceId), /^ev_[a-f0-9]{64}$/);
    assert.equal(
      (await db.listLedgerRecords()).filter(
        (record) => record.evidence.kind === "reef.gateway.route",
      ).length,
      routeCountBefore,
      "standard priority denial must happen before route",
    );
    const standardPlan = await fetchJson(port, "GET", "/v1/plan?tier=priority", {
      token: standardToken,
    });
    assert.equal(standardPlan.status, 200);
    assert.equal(standardPlan.body.selectedTier, "standard");
    const standardTiers = standardPlan.body.tiers as readonly {
      readonly id?: string;
      readonly allowed?: boolean;
    }[];
    assert.equal(
      standardTiers.find((tier) => tier.id === "priority")?.allowed,
      false,
    );

    const priority = await fetchJson(port, "POST", "/v1/admin/accounts", {
      token: "local-g5-admin",
      body: {
        email: "priority-g5@example.test",
        planId: "reef-commercial-priority",
        entitlements: ["inference:complete", "priority:route"],
      },
    });
    assert.equal(priority.status, 201);
    const priorityToken = String(priority.body.accessToken);
    const priorityCompletion = await fetchJson(port, "POST", "/v1/complete", {
      token: priorityToken,
      body: {
        prompt: "Route through priority.",
        priorityTier: "priority",
      },
    });
    assert.equal(priorityCompletion.status, 200);
    const tier = priorityCompletion.body.tier as {
      readonly tier?: string;
      readonly queue?: string;
      readonly serviceLevel?: string;
    };
    assert.equal(tier.tier, "priority");
    assert.equal(tier.queue, "priority");
    assert.match(tier.serviceLevel ?? "", /Priority local plan/);
    const evidence = priorityCompletion.body.evidence as Record<string, string>;
    assert.match(evidence.tier, /^ev_[a-f0-9]{64}$/);

    const priorityPlan = await fetchJson(port, "GET", "/v1/plan?tier=priority", {
      token: priorityToken,
    });
    assert.equal(priorityPlan.status, 200);
    assert.equal(priorityPlan.body.selectedTier, "priority");
    const priorityTiers = priorityPlan.body.tiers as readonly {
      readonly id?: string;
      readonly allowed?: boolean;
    }[];
    assert.equal(
      priorityTiers.find((item) => item.id === "priority")?.allowed,
      true,
    );

    const records = await db.listLedgerRecords();
    assert.ok(
      records.some(
        (record) =>
          record.evidence.kind === "reef.gateway.tier" &&
          (record.evidence.content as { allowed?: boolean }).allowed === false,
      ),
      "standard priority denial should be a tier evidence link",
    );
    assert.ok(
      records.some(
        (record) =>
          record.evidence.kind === "reef.gateway.tier" &&
          (record.evidence.content as { tier?: string; allowed?: boolean })
            .tier === "priority" &&
          (record.evidence.content as { allowed?: boolean }).allowed === true,
      ),
      "priority route selection should be a tier evidence link",
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
