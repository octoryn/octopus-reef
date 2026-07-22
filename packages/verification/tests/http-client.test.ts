import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  MemoryEvidenceStore,
  MemoryVerificationStore,
  StaticVerificationProfileRegistry,
  VerificationAuthenticationError,
  VerificationHttpClient,
  VerificationHttpError,
  VerificationProtocolError,
  VerificationService,
  createVerificationHttpHandler,
  defineTrustedProfile,
  type VerificationRunRequest,
  type VerificationPermission,
  type VerificationTenant,
} from "../src/index.js";

test("typed HTTP client binds tenant, idempotency, strict identity, commands, and exact SSE cursor", async (t) => {
  const imageDigest = sha("image");
  const profile = defineTrustedProfile({
    ref: "verification-profile:http",
    version: "1.0.0",
    sandboxImageDigest: imageDigest,
    maxChecks: 1,
    maxDurationMs: 1000,
    checks: [
      {
        checkRef: "test",
        required: true,
        argv: ["true"],
        workingDirectory: ".",
        timeoutMs: 1000,
        outputLimitBytes: 1024,
        environment: {},
        tool: { name: "true", version: "1", imageDigest },
      },
    ],
  });
  const store = new MemoryVerificationStore();
  const service = new VerificationService({
    store,
    evidence: new MemoryEvidenceStore(),
    profiles: new StaticVerificationProfileRegistry([profile]),
  });
  const tenant = {
    organisationRef: "organisation:http",
    projectRef: "project:http",
  };
  const server = createServer(
    createVerificationHttpHandler(service, {
      pollMs: 5,
      workloadAuthenticator: testWorkloadAuthenticator(tenant),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new VerificationHttpClient({
    baseUrl: `http://127.0.0.1:${address.port}/`,
    tenant,
    headers: { authorization: "Bearer test-workload" },
  });
  const request: VerificationRunRequest = {
    ...tenant,
    candidateRef: "foundation-candidate:http",
    candidateDigest: sha("candidate"),
    sourceBundleRef: "source-bundle:http",
    sourceBundleDigest: sha("bundle"),
    verificationProfileRef: profile.ref,
    verificationProfileVersion: profile.version,
    verificationProfileDigest: profile.digest,
    idempotencyKey: "create-http",
  };
  const created = await client.createRun(request);
  assert.equal(created.state, "queued");
  assert.deepEqual(await client.getRun(created.runRef), created);
  const cancelled = await client.cancelRun(created.runRef, {
    idempotencyKey: "cancel-http",
  });
  assert.equal(cancelled.state, "cancelled");
  const cursors: string[] = [];
  for await (const event of client.streamRunEvents(created.runRef, {
    cursor: "0",
    reconnect: false,
  }))
    cursors.push(event.cursor);
  assert.deepEqual(cursors, [created.eventCursor, cancelled.eventCursor]);
  assert.ok(BigInt(cursors[1]!) > BigInt(cursors[0]!));

  const approve = await fetch(
    `http://127.0.0.1:${address.port}/v1/verifications/${encodeURIComponent(created.runRef)}/approve`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-workload",
        "content-type": "application/json",
        "idempotency-key": "approve",
        "x-organisation-ref": tenant.organisationRef,
        "x-project-ref": tenant.projectRef,
      },
      body: JSON.stringify({ idempotencyKey: "approve" }),
    },
  );
  assert.equal(approve.status, 404);

  const other = new VerificationHttpClient({
    baseUrl: `http://127.0.0.1:${address.port}/`,
    tenant: {
      organisationRef: "organisation:other",
      projectRef: tenant.projectRef,
    },
    headers: { authorization: "Bearer test-workload" },
  });
  await assert.rejects(
    other.getRun(created.runRef),
    (error) => error instanceof VerificationHttpError && error.status === 403,
  );
});

test("verification Run API rejects caller commands and raw credentials", async (t) => {
  const store = new MemoryVerificationStore();
  const service = new VerificationService({
    store,
    evidence: new MemoryEvidenceStore(),
    profiles: new StaticVerificationProfileRegistry([]),
  });
  const tenant = {
    organisationRef: "organisation:test",
    projectRef: "project:test",
  };
  const server = createServer(
    createVerificationHttpHandler(service, {
      workloadAuthenticator: testWorkloadAuthenticator(tenant),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/verifications`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-workload",
        "content-type": "application/json",
        "idempotency-key": "malicious",
        "x-organisation-ref": tenant.organisationRef,
        "x-project-ref": tenant.projectRef,
      },
      body: JSON.stringify({
        idempotencyKey: "malicious",
        command: "curl attacker",
        apiKey: "plaintext",
      }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(
    JSON.stringify(await response.json()).includes("plaintext"),
    false,
  );
});

test("streaming from the exact terminal cursor ends without reconnecting forever", async (t) => {
  const imageDigest = sha("terminal-image");
  const profile = defineTrustedProfile({
    ref: "verification-profile:terminal",
    version: "1.0.0",
    sandboxImageDigest: imageDigest,
    maxChecks: 1,
    maxDurationMs: 1000,
    checks: [
      {
        checkRef: "test",
        required: true,
        argv: ["true"],
        workingDirectory: ".",
        timeoutMs: 1000,
        outputLimitBytes: 1024,
        environment: {},
        tool: { name: "true", version: "1", imageDigest },
      },
    ],
  });
  const service = new VerificationService({
    store: new MemoryVerificationStore(),
    evidence: new MemoryEvidenceStore(),
    profiles: new StaticVerificationProfileRegistry([profile]),
  });
  const tenant = {
    organisationRef: "organisation:terminal",
    projectRef: "project:terminal",
  };
  const server = createServer(
    createVerificationHttpHandler(service, {
      pollMs: 1,
      workloadAuthenticator: testWorkloadAuthenticator(tenant),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let eventRequests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).includes("/events")) eventRequests += 1;
    return fetch(input, init);
  };
  const client = new VerificationHttpClient({
    baseUrl: `http://127.0.0.1:${address.port}/`,
    tenant,
    fetchImpl,
    reconnectDelayMs: 1,
    headers: { authorization: "Bearer test-workload" },
  });
  const request: VerificationRunRequest = {
    ...tenant,
    candidateRef: "foundation-candidate:terminal",
    candidateDigest: sha("terminal-candidate"),
    sourceBundleRef: "source-bundle:terminal",
    sourceBundleDigest: sha("terminal-bundle"),
    verificationProfileRef: profile.ref,
    verificationProfileVersion: profile.version,
    verificationProfileDigest: profile.digest,
    idempotencyKey: "create-terminal",
  };
  const created = await client.createRun(request);
  const cancelled = await client.cancelRun(created.runRef, {
    idempotencyKey: "cancel-terminal",
  });

  const abort = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, 150);
  const events: string[] = [];
  for await (const event of client.streamRunEvents(created.runRef, {
    cursor: cancelled.eventCursor as `${bigint}`,
    signal: abort.signal,
  })) {
    events.push(event.cursor);
  }
  clearTimeout(timeout);
  assert.equal(
    timedOut,
    false,
    "terminal-cursor stream waited for cancellation",
  );
  assert.deepEqual(events, []);
  assert.ok(
    eventRequests <= 1,
    `terminal-cursor stream reconnected ${eventRequests} times`,
  );
});

test("typed client rejects structurally invalid JSON responses at runtime", async () => {
  const tenant = {
    organisationRef: "organisation:schema",
    projectRef: "project:schema",
  };
  const client = new VerificationHttpClient({
    baseUrl: "https://verification.invalid/",
    tenant,
    fetchImpl: async () =>
      new Response(JSON.stringify({ ...tenant, state: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    client.getRun("verification:schema"),
    (error) =>
      error instanceof VerificationProtocolError &&
      error.code === "PROTOCOL_ERROR",
  );
});

test("verification HTTP API fails closed without a verified workload principal", async (t) => {
  const tenant = {
    organisationRef: "organisation:auth",
    projectRef: "project:auth",
  };
  const service = new VerificationService({
    store: new MemoryVerificationStore(),
    evidence: new MemoryEvidenceStore(),
    profiles: new StaticVerificationProfileRegistry([]),
  });
  const server = createServer(
    createVerificationHttpHandler(service, {
      workloadAuthenticator: testWorkloadAuthenticator(tenant),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/verifications/missing`,
    {
      headers: {
        "x-organisation-ref": tenant.organisationRef,
        "x-project-ref": tenant.projectRef,
      },
    },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      code: "VERIFICATION_AUTHENTICATION_FAILED",
      message: "verification workload authorization is required",
      retryable: false,
    },
  });
});

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const ALL_PERMISSIONS: readonly VerificationPermission[] = [
  "verification:create",
  "verification:read",
  "verification:retry",
  "verification:cancel",
  "verification:evidence:read",
];

function testWorkloadAuthenticator(
  tenant: VerificationTenant,
  permissions: readonly VerificationPermission[] = ALL_PERMISSIONS,
) {
  return {
    async authenticate(authorization: string | undefined) {
      if (authorization !== "Bearer test-workload") {
        throw new VerificationAuthenticationError(
          "verification workload authorization is required",
        );
      }
      return {
        subject: "workload:test",
        organisationRef: tenant.organisationRef,
        projectRefs: [tenant.projectRef],
        permissions,
      };
    },
  };
}
