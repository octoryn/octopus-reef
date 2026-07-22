import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  MemoryEvidenceStore,
  MemoryVerificationStore,
  StaticVerificationProfileRegistry,
  VerificationHttpClient,
  VerificationHttpError,
  VerificationService,
  createVerificationHttpHandler,
  defineTrustedProfile,
  type VerificationRunRequest,
} from "../src/index.js";

test("typed HTTP client binds tenant, idempotency, strict identity, commands, and exact SSE cursor", async (t) => {
  const imageDigest = sha("image");
  const profile = defineTrustedProfile({
    ref: "verification-profile:http", version: "1.0.0", sandboxImageDigest: imageDigest,
    maxChecks: 1, maxDurationMs: 1000,
    checks: [{
      checkRef: "test", required: true, argv: ["true"], workingDirectory: ".",
      timeoutMs: 1000, outputLimitBytes: 1024, environment: {},
      tool: { name: "true", version: "1", imageDigest },
    }],
  });
  const store = new MemoryVerificationStore();
  const service = new VerificationService({
    store, evidence: new MemoryEvidenceStore(),
    profiles: new StaticVerificationProfileRegistry([profile]),
  });
  const server = createServer(createVerificationHttpHandler(service, { pollMs: 5 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address === "object");
  const tenant = { organisationRef: "organisation:http", projectRef: "project:http" };
  const client = new VerificationHttpClient({ baseUrl: `http://127.0.0.1:${address.port}/`, tenant });
  const request: VerificationRunRequest = {
    ...tenant,
    candidateRef: "foundation-candidate:http", candidateDigest: sha("candidate"),
    sourceBundleRef: "source-bundle:http", sourceBundleDigest: sha("bundle"),
    verificationProfileRef: profile.ref, verificationProfileVersion: profile.version,
    verificationProfileDigest: profile.digest, idempotencyKey: "create-http",
  };
  const created = await client.createVerification(request);
  assert.equal(created.state, "queued");
  assert.deepEqual(await client.getVerification(created.runRef), created);
  const cancelled = await client.cancelVerification(created.runRef, { idempotencyKey: "cancel-http" });
  assert.equal(cancelled.state, "cancelled");
  const cursors: string[] = [];
  for await (const event of client.streamEvents(created.runRef, { cursor: "0", reconnect: false })) cursors.push(event.cursor);
  assert.deepEqual(cursors, [created.eventCursor, cancelled.eventCursor]);
  assert.ok(BigInt(cursors[1]!) > BigInt(cursors[0]!));

  const approve = await fetch(`http://127.0.0.1:${address.port}/v1/verifications/${encodeURIComponent(created.runRef)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "approve", "x-organisation-ref": tenant.organisationRef, "x-project-ref": tenant.projectRef },
    body: JSON.stringify({ idempotencyKey: "approve" }),
  });
  assert.equal(approve.status, 404);

  const other = new VerificationHttpClient({
    baseUrl: `http://127.0.0.1:${address.port}/`,
    tenant: { organisationRef: "organisation:other", projectRef: tenant.projectRef },
  });
  await assert.rejects(other.getVerification(created.runRef), (error) => error instanceof VerificationHttpError && error.status === 404);
});

test("verification Run API rejects caller commands and raw credentials", async (t) => {
  const store = new MemoryVerificationStore();
  const service = new VerificationService({
    store, evidence: new MemoryEvidenceStore(), profiles: new StaticVerificationProfileRegistry([]),
  });
  const server = createServer(createVerificationHttpHandler(service));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/verifications`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "idempotency-key": "malicious",
      "x-organisation-ref": "organisation:test", "x-project-ref": "project:test",
    },
    body: JSON.stringify({ idempotencyKey: "malicious", command: "curl attacker", apiKey: "plaintext" }),
  });
  assert.equal(response.status, 400);
  assert.equal(JSON.stringify(await response.json()).includes("plaintext"), false);
});

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
