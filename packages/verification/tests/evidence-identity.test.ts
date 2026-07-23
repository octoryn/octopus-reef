import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createEvidence, type Evidence } from "octopus-evidence";
import {
  MemoryVerificationStore,
  StaticVerificationProfileRegistry,
  VerificationHttpClient,
  VerificationProtocolError,
  VerificationService,
  createCheckEvidence,
  defineTrustedProfile,
  evidenceDigest,
  evidenceReference,
  parseArtifactReference,
  putVerifiedEvidence,
  resolveEvidenceEnvelope,
  verificationRunIdentity,
  type VerificationCheckResult,
  type VerificationEvidenceStore,
  type VerificationRun,
  type VerificationTenant,
} from "../src/index.js";

const tenant = {
  organisationRef: "organisation:evidence-identity",
  projectRef: "project:evidence-identity",
};

test("Evidence resolution requires requested ref, returned ref, and Evidence.id to agree", async () => {
  const first = fixtureEvidence(tenant, "first");
  const second = fixtureEvidence(tenant, "second");

  await assert.rejects(
    resolve(
      first.ref,
      storeReturning(second.ref, second.evidence, second.digest),
    ),
    /requested\/returned ref mismatch/,
  );
  await assert.rejects(
    resolve(
      first.ref,
      storeReturning(first.ref, second.evidence, second.digest),
    ),
    /ref\/id mismatch/,
  );
  await assert.rejects(
    resolve(
      first.ref,
      storeReturning(first.ref, first.evidence, sha("wrong-digest")),
    ),
    /digest mismatch/,
  );

  const tampered = structuredClone(first.evidence) as Evidence & {
    content: Record<string, unknown>;
  };
  tampered.content = { ...tampered.content, runRef: "verification:tampered" };
  await assert.rejects(
    resolve(first.ref, storeReturning(first.ref, tampered, first.digest)),
    /integrity verification/,
  );
});

test("Evidence resolution rejects cross-tenant and internally inconsistent replacement", async () => {
  const otherTenant = {
    organisationRef: "organisation:replacement",
    projectRef: tenant.projectRef,
  };
  const replacement = fixtureEvidence(otherTenant, "replacement");
  await assert.rejects(
    resolveEvidenceEnvelope(
      storeReturning(replacement.ref, replacement.evidence, replacement.digest),
      tenant,
      replacement.ref,
    ),
    /tenant identity mismatch/,
  );

  const valid = fixtureEvidence(tenant, "subject-mismatch");
  const inconsistent = structuredClone(valid.evidence);
  const candidate = inconsistent.subject.find(
    (subject) => subject.type === "foundation-candidate",
  );
  assert.ok(candidate);
  const forged = fixtureEvidence(tenant, "forged", {
    subjects: inconsistent.subject.map((subject) =>
      subject.type === "foundation-candidate"
        ? { ...subject, id: "foundation-candidate:replacement" }
        : subject,
    ),
  });
  await assert.rejects(
    resolve(
      forged.ref,
      storeReturning(forged.ref, forged.evidence, forged.digest),
    ),
    /subject identity mismatch/,
  );
});

test("Evidence store put result is verified instead of trusted", async () => {
  const fixture = fixtureEvidence(tenant, "put");
  const malicious: VerificationEvidenceStore = {
    put: async () => ({
      ref: `artifact:${"a".repeat(64)}`,
      digest: fixture.digest,
    }),
    get: async () => undefined,
  };
  await assert.rejects(
    putVerifiedEvidence(malicious, tenant, fixture.evidence),
    /store put identity mismatch/,
  );
});

test("Evidence materialization ref cannot replace its canonical descriptor digest", async () => {
  const base = fixtureRun(tenant, "materialization-replacement");
  const run: VerificationRun = {
    ...base,
    materialization: {
      schemaVersion: "octopus.reef.materialization/v1",
      ref: `materialization:${"a".repeat(64)}`,
      runtimeDescriptorDigest: `sha256:${"b".repeat(64)}`,
      authoritativeSourceBundleDigest: base.sourceBundleDigest,
      entryCount: 1,
      totalBytes: 1,
    },
  };
  const evidence = createCheckEvidence(
    run,
    profileFor(run),
    checkResult(run, verificationRunIdentity(run)),
  );
  const ref = evidenceReference(evidence);
  await assert.rejects(
    resolve(ref, storeReturning(ref, evidence, evidenceDigest(evidence))),
    /materialization ref\/digest mismatch/,
  );
});

test("artifact references cannot masquerade as Evidence references", async () => {
  const evidence = fixtureEvidence(tenant, "artifact-masquerade", {
    artifactRef: `evidence:ev_${"a".repeat(64)}`,
  });
  assert.throws(
    () => parseArtifactReference(`evidence:ev_${"a".repeat(64)}`),
    /artifact ref is not canonical/,
  );
  await assert.rejects(
    resolve(
      evidence.ref,
      storeReturning(evidence.ref, evidence.evidence, evidence.digest),
    ),
    /artifact ref is not canonical/,
  );
  await assert.rejects(
    resolveEvidenceEnvelope(
      storeReturning(evidence.ref, evidence.evidence, evidence.digest),
      tenant,
      `artifact:${"b".repeat(64)}`,
    ),
    /Evidence ref is not canonical/,
  );
});

test("typed client rejects a requested-A/response-B Evidence replacement", async () => {
  const first = fixtureEvidence(tenant, "client-first");
  const second = fixtureEvidence(tenant, "client-second");
  const envelope = await resolveEvidenceEnvelope(
    storeReturning(second.ref, second.evidence, second.digest),
    tenant,
    second.ref,
  );
  assert.ok(envelope);
  const client = new VerificationHttpClient({
    baseUrl: "https://verification.invalid/",
    tenant,
    fetchImpl: async () => Response.json(envelope),
  });
  await assert.rejects(
    client.resolveEvidence(first.ref),
    (error) =>
      error instanceof VerificationProtocolError &&
      /identity echo mismatch/.test(error.message),
  );
});

test("typed run and SSE schemas bind nested check/event identity to the run", async () => {
  const run = fixtureRun(tenant, "schema");
  const identity = verificationRunIdentity(run);
  const check = checkResult(run, {
    ...identity,
    candidateRef: "foundation-candidate:replacement",
  });
  const completed = {
    ...run,
    state: "completed",
    checks: [check],
    verdict: {
      identity,
      outcome: "failed",
      requiredChecks: ["tests"],
      passedRequiredChecks: [],
      failedRequiredChecks: ["tests"],
      evidenceRef: `evidence:ev_${"b".repeat(64)}`,
      evidenceDigest: sha("verdict"),
    },
    finishedAt: new Date(1).toISOString(),
  };
  const runClient = new VerificationHttpClient({
    baseUrl: "https://verification.invalid/",
    tenant,
    fetchImpl: async () => Response.json(completed),
  });
  await assert.rejects(runClient.getRun(run.runRef), VerificationProtocolError);

  let request = 0;
  const eventClient = new VerificationHttpClient({
    baseUrl: "https://verification.invalid/",
    tenant,
    fetchImpl: async () => {
      request += 1;
      if (request === 1) return Response.json(run);
      const event = {
        ...tenant,
        identity,
        id: "event:evidence-identity",
        runRef: run.runRef,
        cursor: "1",
        type: "verification.running",
        data: {
          identity: {
            ...identity,
            sourceBundleRef: "source-bundle:replacement",
          },
        },
        createdAt: run.createdAt,
      };
      return new Response(
        `id: 1\nevent: verification.running\ndata: ${JSON.stringify(event)}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const events = eventClient.streamRunEvents(run.runRef, {
    cursor: "0",
    reconnect: false,
  });
  await assert.rejects(
    events[Symbol.asyncIterator]().next(),
    VerificationProtocolError,
  );
});

async function resolve(ref: string, evidence: VerificationEvidenceStore) {
  const service = new VerificationService({
    store: new MemoryVerificationStore(),
    profiles: new StaticVerificationProfileRegistry([]),
    evidence,
  });
  return service.resolveEvidence(tenant, ref);
}

function storeReturning(
  ref: string,
  evidence: Evidence,
  digest: string,
): VerificationEvidenceStore {
  return {
    put: async () => ({ ref, digest }),
    get: async () => ({ ref, evidence, digest }),
  };
}

function fixtureEvidence(
  evidenceTenant: VerificationTenant,
  suffix: string,
  options: {
    readonly artifactRef?: string;
    readonly subjects?: Evidence["subject"];
  } = {},
) {
  const run = fixtureRun(evidenceTenant, suffix);
  const profile = profileFor(run);
  const result = {
    identity: verificationRunIdentity(run),
    checkRef: "tests",
    required: true,
    outcome: "passed",
    durationMs: 1,
    startedAt: run.createdAt,
    finishedAt: new Date(1).toISOString(),
    exitCode: 0,
    resultCode: "CHECK_PASSED",
    tool: {
      name: "test",
      version: "1.0.0",
      imageDigest: sha("tool"),
    },
    artifacts:
      options.artifactRef === undefined
        ? []
        : [
            {
              ref: options.artifactRef,
              digest: sha("artifact"),
              kind: "test-output",
              mediaType: "text/plain",
              size: 1,
            },
          ],
  } as const;
  const created = createCheckEvidence(run, profile, result);
  const evidence =
    options.subjects === undefined
      ? created
      : createCheckEvidenceWithSubjects(created, options.subjects);
  return {
    run,
    evidence,
    ref: evidenceReference(evidence),
    digest: evidenceDigest(evidence),
  };
}

function createCheckEvidenceWithSubjects(
  evidence: Evidence,
  subject: Evidence["subject"],
): Evidence {
  const content = evidence.content;
  const input = {
    kind: evidence.kind,
    subject,
    ...(evidence.actor === undefined ? {} : { actor: evidence.actor }),
    content,
    provenance: evidence.provenance,
  };
  return createEvidence(input);
}

function fixtureRun(
  runTenant: VerificationTenant,
  suffix: string,
): VerificationRun {
  const now = new Date(0).toISOString();
  return {
    ...runTenant,
    candidateRef: `foundation-candidate:${suffix}`,
    candidateDigest: sha(`candidate-${suffix}`),
    sourceBundleRef: `source-bundle:${suffix}`,
    sourceBundleDigest: sha(`source-${suffix}`),
    verificationProfileRef: `verification-profile:${suffix}`,
    verificationProfileVersion: "1.0.0",
    verificationProfileDigest: profileDigest(suffix),
    runRef: `verification:${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    state: "queued",
    version: 1,
    attempt: 1,
    eventCursor: "0",
    createdAt: now,
    updatedAt: now,
    checks: [],
  };
}

function profileFor(run: VerificationRun) {
  return defineTrustedProfile({
    ref: run.verificationProfileRef,
    version: run.verificationProfileVersion,
    sandboxImageDigest: sha("sandbox"),
    maxChecks: 1,
    maxDurationMs: 1_000,
    checks: [
      {
        checkRef: "tests",
        required: true,
        argv: ["true"],
        workingDirectory: ".",
        timeoutMs: 1_000,
        outputLimitBytes: 1_024,
        environment: {},
        tool: { name: "test", version: "1.0.0", imageDigest: sha("tool") },
      },
    ],
  });
}

function profileDigest(suffix: string): string {
  return defineTrustedProfile({
    ref: `verification-profile:${suffix}`,
    version: "1.0.0",
    sandboxImageDigest: sha("sandbox"),
    maxChecks: 1,
    maxDurationMs: 1_000,
    checks: [
      {
        checkRef: "tests",
        required: true,
        argv: ["true"],
        workingDirectory: ".",
        timeoutMs: 1_000,
        outputLimitBytes: 1_024,
        environment: {},
        tool: { name: "test", version: "1.0.0", imageDigest: sha("tool") },
      },
    ],
  }).digest;
}

function checkResult(
  run: VerificationRun,
  identity: ReturnType<typeof verificationRunIdentity>,
): VerificationCheckResult {
  return {
    identity,
    checkRef: "tests",
    required: true,
    outcome: "failed",
    durationMs: 1,
    startedAt: run.createdAt,
    finishedAt: new Date(1).toISOString(),
    exitCode: 1,
    resultCode: "CHECK_FAILED",
    tool: {
      name: "test",
      version: "1.0.0",
      imageDigest: sha("tool"),
    },
    artifacts: [],
    evidenceRef: `evidence:ev_${"a".repeat(64)}`,
    evidenceDigest: sha("check"),
  };
}

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
