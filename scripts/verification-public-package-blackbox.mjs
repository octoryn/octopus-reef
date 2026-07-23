#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  MemoryEvidenceStore,
  MemoryVerificationStore,
  StaticVerificationProfileRegistry,
  VerificationHttpClient,
  VerificationService,
  createVerificationHttpHandler,
  defineTrustedProfile,
  resolveVerificationSseCursor,
} from "@octopus-reef/control-plane/verification";
import {
  externalMaterializationRequest,
  parseExternalMaterializationRequest,
} from "@octopus-reef/control-plane/verification/materialization";

const tenant = {
  organisationRef: "organisation:public-blackbox",
  projectRef: "project:public-blackbox",
};
const profile = defineTrustedProfile({
  ref: "verification-profile:public-blackbox",
  version: "1.0.0",
  sandboxImageDigest: digest("sandbox"),
  maxDurationMs: 1_000,
  maxChecks: 1,
  checks: [
    {
      checkRef: "noop",
      required: true,
      argv: ["true"],
      workingDirectory: ".",
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
      environment: {},
      tool: {
        name: "true",
        version: "1.0.0",
        imageDigest: digest("tool"),
      },
    },
  ],
});
const service = new VerificationService({
  store: new MemoryVerificationStore(),
  evidence: new MemoryEvidenceStore(),
  profiles: new StaticVerificationProfileRegistry([profile]),
  id: () => "verification:public-blackbox",
  now: () => "2026-07-23T00:00:00.000Z",
});
const handler = createVerificationHttpHandler(service, {
  workloadAuthenticator: {
    authenticate: async () => ({
      subject: "workload:public-blackbox",
      organisationRef: tenant.organisationRef,
      projectRefs: [tenant.projectRef],
      permissions: [
        "verification:create",
        "verification:read",
        "verification:retry",
        "verification:cancel",
        "verification:evidence:read",
      ],
    }),
  },
  readiness: async () => undefined,
  streamPollMs: 1,
});
const server = createServer(handler);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  const authHeaders = {
    authorization: "Bearer public-blackbox",
    "x-organisation-ref": tenant.organisationRef,
    "x-project-ref": tenant.projectRef,
  };
  const client = new VerificationHttpClient({
    baseUrl,
    tenant,
    headers: { authorization: "Bearer public-blackbox" },
    reconnectDelayMs: 1,
  });
  const request = {
    ...tenant,
    candidateRef: "foundation-candidate:public-blackbox",
    candidateDigest: digest("candidate"),
    sourceBundleRef: "source-bundle:public-blackbox",
    sourceBundleDigest: digest("source"),
    verificationProfileRef: profile.ref,
    verificationProfileVersion: profile.version,
    verificationProfileDigest: profile.digest,
    idempotencyKey: "public-blackbox",
  };
  const created = await client.createRun(request);
  assert.equal(created.eventCursor, "1");
  assert.deepEqual(await client.getRun(created.runRef), created);

  const eventsUrl = `${baseUrl}v1/verifications/${encodeURIComponent(created.runRef)}/events`;
  const eventsResponse = await fetch(`${eventsUrl}?cursor=0`, {
    headers: authHeaders,
  });
  assert.equal(eventsResponse.status, 200);
  const eventBody = await eventsResponse.json();
  assert.equal(eventBody.events[0].cursor, "1");

  for (const cursor of [
    "01",
    "+1",
    "-0",
    "",
    " ",
    "1e3",
    "1.0",
    " 1",
    "1 ",
    "١",
    "１",
  ]) {
    assert.throws(
      () => resolveVerificationSseCursor(cursor, undefined),
      /canonical non-negative ASCII decimal/,
    );
    const query = new URL(eventsUrl);
    query.searchParams.set("cursor", cursor);
    const response = await fetch(query, { headers: authHeaders });
    assert.equal(response.status, 400, `query cursor accepted: ${cursor}`);
    // HTTP/1 parsers remove optional whitespace around a header field value
    // before exposing IncomingMessage. The exported transport resolver above
    // still rejects the unnormalized value at its actual application boundary.
    if (
      cursor !== " 1" &&
      cursor !== "1 " &&
      [...cursor].every((character) => character.codePointAt(0) <= 0xff)
    ) {
      const lastEventResponse = await fetch(eventsUrl, {
        headers: { ...authHeaders, "last-event-id": cursor },
      });
      assert.equal(
        lastEventResponse.status,
        400,
        `Last-Event-ID accepted: ${cursor}`,
      );
    }
  }

  const huge = "900719925474099312345678901234567890";
  const hugeResponse = await fetch(`${eventsUrl}?cursor=${huge}`, {
    headers: { ...authHeaders, "last-event-id": huge },
  });
  assert.equal(hugeResponse.status, 200);
  assert.deepEqual((await hugeResponse.json()).events, []);

  const numberCursor = client.streamRunEvents(created.runRef, {
    cursor: Number.MAX_SAFE_INTEGER,
    reconnect: false,
  });
  await assert.rejects(
    numberCursor[Symbol.asyncIterator]().next(),
    /canonical decimal/,
  );

  const cancelled = await client.cancelRun(created.runRef, {
    idempotencyKey: "public-blackbox-cancel",
  });
  const terminal = client.streamRunEvents(created.runRef, {
    cursor: cancelled.eventCursor,
    reconnect: true,
  });
  assert.deepEqual(await terminal[Symbol.asyncIterator]().next(), {
    done: true,
    value: undefined,
  });

  const external = externalMaterializationRequest({
    ...cancelled,
    state: "running",
  });
  assert.deepEqual(parseExternalMaterializationRequest(external), external);
  for (const key of [
    "url",
    "s3Uri",
    "bucket",
    "key",
    "command",
    "argv",
    "cwd",
    "env",
    "credentials",
    "secretRef",
  ]) {
    assert.throws(
      () =>
        parseExternalMaterializationRequest({
          ...external,
          [key]: "forbidden",
        }),
      /forbidden fields/,
    );
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
