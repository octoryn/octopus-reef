import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import {
  MemoryEvidenceStore,
  MemoryVerificationStore,
  StaticVerificationProfileRegistry,
  VerificationAuthenticationError,
  VerificationHttpClient,
  VerificationProtocolError,
  VerificationService,
  createVerificationHttpHandler,
  defineTrustedProfile,
  parseVerificationDecimalCursor,
  resolveVerificationSseCursor,
  type VerificationPermission,
  type VerificationRun,
  type VerificationRunRequest,
  type VerificationTenant,
} from "../src/index.js";
import {
  PostgresVerificationStore,
  type VerificationPgPoolLike,
} from "../src/adapters/postgres.js";

const INVALID_CURSORS: readonly unknown[] = [
  "01",
  "+1",
  "-0",
  "",
  " ",
  "1e3",
  "1.0",
  " 1",
  "1 ",
  "\t1",
  "١",
  "１",
  1,
  Number.MAX_SAFE_INTEGER + 1,
  1n,
  null,
];

test("canonical decimal cursor parser is string-only and BigInt-safe", () => {
  assert.equal(parseVerificationDecimalCursor("0"), "0");
  assert.equal(parseVerificationDecimalCursor("1"), "1");
  assert.equal(
    parseVerificationDecimalCursor("999999999999999999999999999999999999"),
    "999999999999999999999999999999999999",
  );
  for (const cursor of INVALID_CURSORS) {
    assert.throws(
      () => parseVerificationDecimalCursor(cursor),
      /canonical non-negative ASCII decimal/,
    );
  }
});

test("SSE cursor resolution rejects normalization and conflicting transports", () => {
  assert.equal(resolveVerificationSseCursor(undefined, undefined), "0");
  assert.equal(resolveVerificationSseCursor("12", undefined), "12");
  assert.equal(resolveVerificationSseCursor(undefined, "12"), "12");
  assert.equal(resolveVerificationSseCursor("12", "12"), "12");
  for (const cursor of INVALID_CURSORS.filter(
    (value): value is string => typeof value === "string",
  )) {
    assert.throws(() => resolveVerificationSseCursor(cursor, undefined));
    assert.throws(() => resolveVerificationSseCursor(undefined, cursor));
  }
  assert.throws(() => resolveVerificationSseCursor("1", "2"), /must match/);
});

test("HTTP events API rejects every noncanonical cursor and preserves a huge cursor", async (t) => {
  const fixture = await httpFixture(t);
  for (const cursor of INVALID_CURSORS.filter(
    (value): value is string => typeof value === "string",
  )) {
    const query = new URL(
      `v1/verifications/${encodeURIComponent(fixture.run.runRef)}/events`,
      fixture.baseUrl,
    );
    query.searchParams.set("cursor", cursor);
    const response = await fetch(query, {
      headers: fixture.headers,
    });
    assert.equal(
      response.status,
      400,
      `query cursor ${JSON.stringify(cursor)}`,
    );
  }

  const huge = "900719925474099312345678901234567890";
  const accepted = await fetch(
    new URL(
      `v1/verifications/${encodeURIComponent(fixture.run.runRef)}/events?cursor=${huge}`,
      fixture.baseUrl,
    ),
    { headers: fixture.headers },
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { events: [] });

  const conflict = await fetch(
    new URL(
      `v1/verifications/${encodeURIComponent(fixture.run.runRef)}/events?cursor=2`,
      fixture.baseUrl,
    ),
    {
      headers: { ...fixture.headers, "Last-Event-ID": "1" },
    },
  );
  assert.equal(conflict.status, 400);
});

test("typed client rejects noncanonical input and unsafe response coercion", async () => {
  const tenant = {
    organisationRef: "organisation:cursor-client",
    projectRef: "project:cursor-client",
  };
  let requests = 0;
  const valid = run(tenant, "0");
  const client = new VerificationHttpClient({
    baseUrl: "https://verification.invalid/",
    tenant,
    fetchImpl: async () => {
      requests += 1;
      return Response.json(valid);
    },
  });
  for (const cursor of INVALID_CURSORS) {
    const iterator = client.streamRunEvents(valid.runRef, {
      cursor: cursor as never,
    });
    await assert.rejects(
      iterator[Symbol.asyncIterator]().next(),
      VerificationProtocolError,
    );
  }
  assert.equal(requests, 0);

  for (const cursor of [...INVALID_CURSORS, "01"].filter(
    (value) => typeof value !== "bigint",
  )) {
    const responseClient = new VerificationHttpClient({
      baseUrl: "https://verification.invalid/",
      tenant,
      fetchImpl: async () => Response.json({ ...valid, eventCursor: cursor }),
    });
    await assert.rejects(
      responseClient.getRun(valid.runRef),
      VerificationProtocolError,
    );
  }
});

test("typed SSE parser rejects a noncanonical frame id without reconnecting", async () => {
  const tenant = {
    organisationRef: "organisation:cursor-sse",
    projectRef: "project:cursor-sse",
  };
  const valid = run(tenant, "1");
  let request = 0;
  const client = new VerificationHttpClient({
    baseUrl: "https://verification.invalid/",
    tenant,
    fetchImpl: async () => {
      request += 1;
      if (request === 1) return Response.json(valid);
      return new Response(
        `id: 01\nevent: verification.queued\ndata: ${JSON.stringify({
          ...event(valid),
          cursor: "01",
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const iterator = client.streamRunEvents(valid.runRef, {
    cursor: "0",
    reconnect: false,
  });
  await assert.rejects(
    iterator[Symbol.asyncIterator]().next(),
    VerificationProtocolError,
  );
});

test("PostgreSQL adapter fails closed if a driver coerces bigint cursor to number", async () => {
  const tenant = {
    organisationRef: "organisation:cursor-pg-driver",
    projectRef: "project:cursor-pg-driver",
  };
  const pool = {
    async query() {
      return {
        rows: [
          {
            cursor: Number.MAX_SAFE_INTEGER + 1,
            id: "event:unsafe-number",
            organisation_ref: tenant.organisationRef,
            project_ref: tenant.projectRef,
            run_ref: "verification:cursor-pg-driver",
            type: "verification.queued",
            data: {},
            created_at: new Date(0),
          },
        ],
      };
    },
  } as unknown as VerificationPgPoolLike;
  const store = new PostgresVerificationStore(pool);
  await assert.rejects(
    store.events(tenant, "verification:cursor-pg-driver"),
    /persisted event cursor must be 0 or a canonical non-negative ASCII decimal/,
  );
});

async function httpFixture(t: TestContext): Promise<{
  readonly baseUrl: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly run: VerificationRun;
}> {
  const tenant = {
    organisationRef: "organisation:cursor-http",
    projectRef: "project:cursor-http",
  };
  const profile = defineTrustedProfile({
    ref: "verification-profile:cursor-http",
    version: "1.0.0",
    sandboxImageDigest: sha("sandbox"),
    maxChecks: 1,
    maxDurationMs: 1_000,
    checks: [
      {
        checkRef: "cursor",
        required: true,
        argv: ["true"],
        workingDirectory: ".",
        timeoutMs: 1_000,
        outputLimitBytes: 1_024,
        environment: {},
        tool: { name: "true", version: "1", imageDigest: sha("tool") },
      },
    ],
  });
  const service = new VerificationService({
    store: new MemoryVerificationStore(),
    evidence: new MemoryEvidenceStore(),
    profiles: new StaticVerificationProfileRegistry([profile]),
    id: () => "verification:cursor-http",
  });
  const created = await service.createRun(tenant, {
    ...identity(tenant),
    verificationProfileRef: profile.ref,
    verificationProfileVersion: profile.version,
    verificationProfileDigest: profile.digest,
    idempotencyKey: "cursor-http",
  });
  const server = createServer(
    createVerificationHttpHandler(service, {
      workloadAuthenticator: authenticator(tenant),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}/`),
    headers: {
      authorization: "Bearer cursor-test",
      "x-organisation-ref": tenant.organisationRef,
      "x-project-ref": tenant.projectRef,
    },
    run: created,
  };
}

function run(tenant: VerificationTenant, eventCursor: string): VerificationRun {
  const now = new Date(0).toISOString();
  return {
    ...identity(tenant),
    runRef: "verification:cursor-client",
    idempotencyKey: "cursor-client",
    state: "queued",
    version: 1,
    attempt: 1,
    eventCursor: eventCursor as never,
    createdAt: now,
    updatedAt: now,
    checks: [],
  };
}

function event(runValue: VerificationRun) {
  return {
    organisationRef: runValue.organisationRef,
    projectRef: runValue.projectRef,
    id: "event:cursor",
    runRef: runValue.runRef,
    cursor: "01",
    type: "verification.queued",
    data: {
      identity: {
        organisationRef: runValue.organisationRef,
        projectRef: runValue.projectRef,
        candidateRef: runValue.candidateRef,
        candidateDigest: runValue.candidateDigest,
        sourceBundleRef: runValue.sourceBundleRef,
        sourceBundleDigest: runValue.sourceBundleDigest,
        verificationProfileRef: runValue.verificationProfileRef,
        verificationProfileVersion: runValue.verificationProfileVersion,
        verificationProfileDigest: runValue.verificationProfileDigest,
      },
    },
    createdAt: runValue.createdAt,
  };
}

function identity(tenant: VerificationTenant): Omit<
  VerificationRunRequest,
  | "verificationProfileRef"
  | "verificationProfileVersion"
  | "verificationProfileDigest"
  | "idempotencyKey"
> & {
  verificationProfileRef: string;
  verificationProfileVersion: string;
  verificationProfileDigest: string;
} {
  return {
    ...tenant,
    candidateRef: "foundation-candidate:cursor",
    candidateDigest: sha("candidate"),
    sourceBundleRef: "source-bundle:cursor",
    sourceBundleDigest: sha("source"),
    verificationProfileRef: "verification-profile:cursor",
    verificationProfileVersion: "1.0.0",
    verificationProfileDigest: sha("profile"),
  };
}

function authenticator(tenant: VerificationTenant) {
  const permissions: readonly VerificationPermission[] = [
    "verification:create",
    "verification:read",
    "verification:retry",
    "verification:cancel",
    "verification:evidence:read",
  ];
  return {
    async authenticate(authorization: string | undefined) {
      if (authorization !== "Bearer cursor-test") {
        throw new VerificationAuthenticationError("authentication required");
      }
      return {
        subject: "workload:cursor-test",
        organisationRef: tenant.organisationRef,
        projectRefs: [tenant.projectRef],
        permissions,
      };
    },
  };
}

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
