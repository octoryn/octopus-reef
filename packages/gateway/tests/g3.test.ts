import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GatewayControlPlane,
  GatewayHttpServer,
  SqliteGatewayDb,
  loadGatewayConfig,
} from "../src/index.js";

test("G3: signup/login issue signed tokens and license revoke denies completion", async () => {
  const db = new SqliteGatewayDb(":memory:");
  const config = loadGatewayConfig({
    REEF_GATEWAY_DB_URL: "sqlite::memory:",
    REEF_GATEWAY_JWT_SECRET: "local-g3-jwt-secret",
    REEF_GATEWAY_LEDGER_SECRET: "local-g3-ledger-secret",
  });
  const control = new GatewayControlPlane({ config, db });
  const server = new GatewayHttpServer(control);
  const port = await server.listen(0, "127.0.0.1");
  try {
    const signup = await fetchJson(port, "POST", "/v1/signup", {
      body: {
        email: "signup@example.test",
        password: "correct horse battery",
        displayName: "Signup User",
      },
    });
    assert.equal(signup.status, 201);
    assert.match(String(signup.body.accessToken), /^[^.]+\.[^.]+\.[^.]+$/);

    const badLogin = await fetchJson(port, "POST", "/v1/login", {
      body: {
        email: "signup@example.test",
        password: "wrong password",
      },
    });
    assert.equal(badLogin.status, 401);
    assert.match(String(badLogin.body.evidenceId), /^ev_[a-f0-9]{64}$/);

    const login = await fetchJson(port, "POST", "/v1/login", {
      body: {
        email: "signup@example.test",
        password: "correct horse battery",
      },
    });
    assert.equal(login.status, 200);
    const token = String(login.body.accessToken);
    assert.match(token, /^[^.]+\.[^.]+\.[^.]+$/);

    const completion = await fetchJson(port, "POST", "/v1/complete", {
      token,
      body: { prompt: "Complete before revoke." },
    });
    assert.equal(completion.status, 200);

    const revoke = await fetchJson(port, "POST", "/v1/license/revoke", {
      token,
    });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.revoked, true);

    const denied = await fetchJson(port, "POST", "/v1/complete", {
      token,
      body: { prompt: "Complete after revoke." },
    });
    assert.equal(denied.status, 403);
    assert.match(String(denied.body.evidenceId), /^ev_[a-f0-9]{64}$/);

    const records = await db.listLedgerRecords();
    assert.ok(
      records.some(
        (record) => record.evidence.kind === "reef.gateway.account.signup",
      ),
    );
    assert.ok(
      records.some(
        (record) => record.evidence.kind === "reef.gateway.license.revoke",
      ),
    );
    assert.ok(
      records.some(
        (record) =>
          record.evidence.kind === "reef.gateway.auth" &&
          record.evidence.provenance.method === "password" &&
          (record.evidence.content as { allowed?: boolean }).allowed === true,
      ),
      "successful login should be evidence-backed",
    );
    assert.ok(
      records.some(
        (record) =>
          record.evidence.kind === "reef.gateway.entitlement" &&
          (record.evidence.content as { allowed?: boolean; reason?: string })
            .allowed === false,
      ),
      "revoked license should drive an entitlement denial",
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
