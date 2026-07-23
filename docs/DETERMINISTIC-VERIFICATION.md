# Deterministic Verification Runtime 0.3

Deterministic Verification is a separate Reef aggregate. It is not an
`AgentRun`, does not load a model or Agent Loop, and has no pause, review,
approve, or reject operation. A Reef verification decision never approves a
Builder deliverable and never advances Builder Project State.

## Release and compatibility identity

Builder pins these public packages exactly:

```text
@octopus-reef/control-plane@0.3.0
@octopus-reef/verification@0.3.0
@octopus-reef/engine@0.2.1
@octopus-reef/protocol@0.1.1
@octopus-reef/agent@0.2.3
@octopus-reef/adapter-runtime@0.1.1
octopus-evidence@0.2.0
```

The Builder-facing exports are:

```text
@octopus-reef/control-plane/verification
@octopus-reef/control-plane/verification/client
@octopus-reef/control-plane/verification/materialization
```

HTTP v1 is `/v1/verifications`. Patch releases in the 0.2 line may make
backward-compatible fixes. A closed request key, state, identity, cursor, or
Evidence schema break requires a new minor or major API/package line.

The PostgreSQL schema head is `0002_materialization`. Run migrations before API or
Worker rollout:

```text
reef-verification migrate
reef-verification api
reef-verification worker
```

The migration set digest and immutable image manifest digests are published in
the `control-plane-v0.3.0` GitHub Release record. Deploy images by manifest
digest, never by a mutable tag.

## Public protocol

The only operations are create, get, exact-cursor SSE stream, retry, cancel,
and tenant-scoped Evidence resolution. Create accepts exactly:

```ts
import { VerificationHttpClient } from "@octopus-reef/control-plane/verification/client";

const reef = new VerificationHttpClient({
  baseUrl: process.env.REEF_VERIFICATION_URL!,
  tenant: { organisationRef, projectRef },
  headers: {
    authorization: `Bearer ${await workloadTokenResolver.resolve({
      name: "reefVerificationWorkloadToken",
      secretRef: "aws-secretsmanager://reef/builder-staging/workload-token",
    })}`,
  },
});

const run = await reef.createRun({
  organisationRef,
  projectRef,
  candidateRef,
  candidateDigest,
  sourceBundleRef,
  sourceBundleDigest,
  verificationProfileRef,
  verificationProfileVersion,
  verificationProfileDigest,
  idempotencyKey: manufacturingAttemptRef,
});

for await (const event of reef.streamRunEvents(run.runRef, {
  cursor: persistedExactDecimalCursor,
})) {
  await persistExactDecimalCursor(event.cursor);
}
```

The Run body never accepts command, argv, cwd, environment, task, raw
credential, or secret reference. Workload authentication is outside the Run
body. Tenant headers are selectors only; the offline, deployment-owned JWKS
authenticator binds them to the verified JWT subject, project membership, and
route permission.

Responses, events, and Evidence bind the complete organisation/project,
candidate, source bundle, and immutable profile identity. Cursors are canonical
decimal strings and must never be converted to a JavaScript `number`. A stream
opened at the exact terminal cursor returns EOF without reconnecting.

The deployment-neutral external materialization Port is published from
`@octopus-reef/control-plane/verification/materialization`. Its request contains
only the full identity, run, and attempt plus opaque refs. Deployment-owned
adapters resolve those refs against trusted ArtifactStore/S3 configuration;
callers cannot provide URLs, S3 locations, commands, credentials, or arbitrary
secret refs. Reef verifies the Builder-owned
`octopus.builder.source-bundle/v1` candidate digest and separately records the
canonical `octopus.reef.materialization-descriptor/v1` digest. The two digests
are never interchangeable.

## Result and Evidence semantics

Required-check coverage is distinct from operational state:

```text
test/build/migration/scan failure -> state=completed, verdict.outcome=failed
infrastructure/protocol/isolation failure -> state=failed, failure.retryable=...
```

Every check and final verdict is created and verified by
`octopus-evidence@0.2.0`. The envelope digest is the lowercase
`sha256:` prefix plus `octopus-evidence` canonical hash. Consumers can verify
integrity and canonical digest without a Reef secret. Evidence is technical
execution evidence, not a compliance certification or penetration-test claim.

## Production configuration names

Secret values belong in the deployment secret provider; only names and
`secretRef` values belong in configuration or profiles.

```text
REEF_VERIFICATION_DATABASE_URL
REEF_VERIFICATION_DATABASE_SSL_MODE
REEF_VERIFICATION_DATABASE_CA_FILE
REEF_VERIFICATION_PROFILES_FILE
REEF_VERIFICATION_WORKLOAD_JWKS_FILE
REEF_VERIFICATION_WORKLOAD_ISSUER
REEF_VERIFICATION_WORKLOAD_AUDIENCE
REEF_VERIFICATION_QUEUE_ADAPTER
REEF_VERIFICATION_SQS_QUEUE_URL
REEF_VERIFICATION_OBJECT_STORE
REEF_VERIFICATION_S3_BUCKET
REEF_VERIFICATION_S3_PREFIX
REEF_VERIFICATION_S3_KMS_KEY_ID
REEF_VERIFICATION_SECRET_RESOLVER
REEF_VERIFICATION_SANDBOX_ADAPTER
REEF_VERIFICATION_ECS_CLUSTER
REEF_VERIFICATION_ECS_TASK_DEFINITIONS_FILE
REEF_VERIFICATION_ECS_SUBNETS
REEF_VERIFICATION_ECS_SECURITY_GROUPS
REEF_VERIFICATION_ECS_RUNNER_SHARED_SECRET
REEF_VERIFICATION_ECS_CONTAINER_NAME
REEF_VERIFICATION_ECS_RUNNER_PORT
```

`verify-full` uses the checksum-pinned RDS global CA bundle at
`/etc/ssl/certs/aws-rds-global-bundle.pem`. `/health/live` is process liveness;
`/health/ready` verifies PostgreSQL connectivity and the schema head.

See [DETERMINISTIC-VERIFICATION-AWS.md](./DETERMINISTIC-VERIFICATION-AWS.md)
for the minimal remote deployment and least-privilege boundary.

See
[DETERMINISTIC-VERIFICATION-0.3-MIGRATION.md](./DETERMINISTIC-VERIFICATION-0.3-MIGRATION.md)
for the mandatory exact-version cutover from 0.2.2.

## Builder boundary

Builder calls the published server-side typed client through its own
`AgentRuntimePort`. It must not import a sibling Reef source directory, use a
`file:` dependency, copy the Agent Loop, or maintain a fork. All
organisation/project/candidate/source/profile refs remain opaque. Builder owns
deliverable acceptance and Project State after it evaluates the deterministic
result.
