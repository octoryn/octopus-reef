# Control Plane compatibility and remote consumption

## Published contract

`@octopus-reef/control-plane` 0.4.0 is the current compatible release. It
publishes two deliberately separate product contracts.

The Agent Execution contract remains HTTP `/v1/runs` with AgentRun
pause/resume/review semantics inherited from the 0.1 line. The Deterministic
Verification contract is HTTP `/v1/verifications`, exported from
`@octopus-reef/control-plane/verification`, and supports only
create/get/stream/retry/cancel. Verification is not an AgentRun and never
approves a Builder deliverable.

The Agent Execution side publishes three deployment artifacts:

- the deployment-neutral ports, state machine, worker and typed HTTP client;
- HTTP Run API v1 at `/v1/runs` and cursor-based SSE events;
- immutable API, Worker and isolated sandbox-runner images. Their supported
  entrypoints are `reef-control-plane api`, `reef-control-plane worker`, and
  `reef-sandbox-runner`.

Pin npm to an exact version in production. Pin the service image by the
`sha256:` digests recorded in the matching GitHub Release, not only
by their human-readable tags. npm versions and release image tags are never
overwritten by the release workflow.

The Verification API, Worker, and remote sandbox digests, migration-set digest,
trusted profile ref/version/digest, npm integrity, and known-unverified list are
recorded in the `control-plane-v0.4.0` Release. Its full deployment contract is
in `docs/DETERMINISTIC-VERIFICATION.md`.

## Versioning

The package follows Semantic Versioning. While it is below 1.0:

- `0.1.x` patches preserve the public TypeScript and HTTP v1 contracts;
- a `0.y.0` minor may contain a breaking TypeScript or runtime change and must
  ship migration notes;
- additive event fields and new event types are compatible changes; consumers
  must ignore unknown fields and event types;
- persisted decimal cursors are opaque integers. Never coerce a cursor to a
  JavaScript `number`; persist and return the exact string;
- `projectRef`, `workItemRef`, `acceptanceRef` and `baselineRevisionRef` are
  opaque. Reef persists and returns them without interpreting Builder state;
- all mutating commands carry an `idempotencyKey`. Replaying the same command
  returns the current Run, while reusing its key with a changed payload returns
  `IDEMPOTENCY_CONFLICT`;
- a client and server should use the same `0.y` line until 1.0. A newer patch
  client may connect to an older patch server only when it does not call a newly
  added endpoint.

The 0.1 line is built for Node.js 22+, PostgreSQL 15+, and these existing Reef
kernel contracts:

| Dependency                               | Compatible line                            |
| ---------------------------------------- | ------------------------------------------ |
| `@octopus-reef/agent`                    | `^0.2.3` (checkpoint/resume + Bedrock IAM) |
| `@octopus-reef/engine`                   | `^0.2.1` (tool idempotency)                |
| `@octopus-reef/protocol`                 | `^0.1.1` (decimal cursor events)           |
| `@octopus-reef/adapter-runtime`          | `^0.1.1` (uses engine `^0.2.1`)            |
| `octopus-workstate` / `octopus-evidence` | `^0.2.0`                                   |
| `octopus-runtime`                        | `^0.7.0`                                   |

`OctopusIntentAcceptanceVerifier` accepts the official `checkContract`
function through a typed injection seam. This deliberately avoids a sibling
source import or a local `file:` dependency while still using the authoritative
checker selected by the deployment.

The separate Verification runtime is 0.4.0 and requires
`@octopus-reef/control-plane@0.4.0` plus
`@octopus-reef/verification@0.4.0` exactly. Builder must not use a semver range,
workspace fallback, copied implementation, or legacy materialization fallback.
Version 0.4.0 corrects the 0.3 collision in which Reef reused
`octopus.builder.source-bundle/v1` for a different shape and digest. The 0.3
extension is incompatible and cannot be relabelled or reinterpreted. Its
ordered cutover is documented in
`docs/DETERMINISTIC-VERIFICATION-0.4-MIGRATION.md`.

## Builder boundary

Builder consumes Reef server-side only through its `AgentRuntimePort` adapter.
That adapter may depend on the published npm client, but it must not import a
sibling Reef source tree, copy the Agent Loop, use a `file:` dependency, or
maintain a fork. `projectRef`, `workItemRef`, and `acceptanceRef` remain opaque
references to Reef.

The Reef `approve` endpoint decides only the pending review on an `AgentRun` and
may requeue that run. It does not approve a Builder deliverable and cannot
advance Builder Project State. Builder keeps those decisions behind its own
ports and state machine after it evaluates the final Reef result.

## Typed client

```ts
import { ControlPlaneHttpClient } from "@octopus-reef/control-plane/client";

const reef = new ControlPlaneHttpClient({
  baseUrl: process.env.REEF_CONTROL_PLANE_URL!,
  tenant: { organisationId, projectId },
});

const run = await reef.createRun({
  task: "implement the accepted work item",
  idempotencyKey: workItemExecutionId,
  projectRef,
  baselineRevisionRef,
  workItemRef,
  acceptanceRef,
  secretRefs: [
    { name: "modelApiKey", secretRef: "aws-secrets://reef/model-prod" },
  ],
});

await reef.resume(run.id, { idempotencyKey: `${workItemExecutionId}:resume` });
await reef.cancel(run.id, {
  idempotencyKey: `${workItemExecutionId}:cancel`,
  reason: "cancelled by the operator",
});
await reef.approve(run.id, {
  idempotencyKey: `${workItemExecutionId}:approve`,
  actorRef: reviewerRef,
});
await reef.reject(run.id, {
  idempotencyKey: `${workItemExecutionId}:reject`,
  actorRef: reviewerRef,
  reason: "candidate needs changes",
});

for await (const event of reef.streamEvents(run.id, {
  cursor: persistedCursor,
})) {
  await saveCursor(event.cursor); // exact decimal string
}

const finished = await reef.getRun(run.id);
finished.status; // AgentExecutionState, including WAITING_FOR_TOOL/BUDGET_EXCEEDED
finished.resultRefs.diffRef;
finished.resultRefs.testRef;
finished.resultRefs.evidenceRefs;
```

The client always projects `x-organisation-id` and `x-project-id`, reconnects
SSE using both `cursor` and `Last-Event-ID`, suppresses duplicate events, and
throws `ControlPlaneHttpError`, `ControlPlaneNetworkError`, or
`ControlPlaneProtocolError`. It sends `Idempotency-Key` as well as the typed
JSON command field so gateways and the service enforce the same key. Run
credentials are references shaped exactly as
`{ name, secretRef }`; secret values and API keys are rejected by the Run API.

Schema migration `0003_transactional_dispatch` adds the leased dispatch outbox.
Run `reef-control-plane migrate` before rolling out 0.1.3, or set
`REEF_CONTROL_PLANE_AUTO_MIGRATE=true` on the API reference deployment. Run
creation/resume/retry now commit the run mutation, event/event-outbox and
dispatch-outbox atomically. A publisher crash may create a duplicate queue
delivery but cannot lose the dispatch; worker fencing and semantic checkpoint
keys make the duplicate safe.

`AgentExecutionState` remains the closed 0.1.x union `QUEUED | PROVISIONING |
PLANNING | RUNNING | WAITING_FOR_TOOL | VERIFYING | WAITING_FOR_REVIEW |
COMPLETED | FAILED | CANCELLED | BUDGET_EXCEEDED`. Builder may project these
into product wording, but must not treat an execution state as Project State.

## Minimal remote API deployment

The reference Compose file starts PostgreSQL plus the official API and Worker
images. Read both exact digests from the GitHub Release, then run:

```sh
export REEF_CONTROL_PLANE_API_IMAGE='ghcr.io/octoryn/octopus-reef-control-plane-api@sha256:<api-digest>'
export REEF_CONTROL_PLANE_WORKER_IMAGE='ghcr.io/octoryn/octopus-reef-control-plane-worker@sha256:<worker-digest>'
export ANTHROPIC_API_KEY='<worker-only-secret>'
docker compose -f examples/control-plane/docker-compose.yml up -d
curl --fail http://127.0.0.1:8080/readyz
```

The API image owns HTTP, PostgreSQL persistence and dispatch publication. The
Worker image wires PostgreSQL/SQS, local/Docker/ECS sandbox, local/S3 artifacts,
Git worktrees, env/Secrets Manager resolution, and Anthropic/Bedrock providers.
This separation keeps provider credentials and sandbox privileges out of the
public API process. `/healthz` is liveness only; `/readyz` verifies database
connectivity and the complete 0.1.3 schema. For Amazon RDS set
`REEF_CONTROL_PLANE_DATABASE_SSL_MODE=verify-full`; the official image reads its
checksum-pinned global CA bundle from
`/etc/ssl/certs/aws-rds-global-bundle.pem`. An explicit
`REEF_CONTROL_PLANE_DATABASE_CA_FILE` or `_CA_BASE64` may override it. For
production, place the API behind
TLS and authentication that derives the two tenant headers from the verified
identity; never trust tenant headers supplied directly by an Internet client.

Infrastructure failures return typed retryable `500` or `503` responses. Retry
mutations with the original idempotency key; never manufacture a new key after
an ambiguous timeout.

The 0.1.3 HTTP routes, payloads, execution-state union, decimal cursor handling
and typed client signatures are unchanged from 0.1.2. The added
`bedrock-iam` provider and ECS task-local runner are Worker deployment options;
they add no Builder-visible contract and do not interpret opaque references.

For the supported Fargate runner, minimum IAM and network layout, see
`docs/CONTROL-PLANE-AWS.md`.
