# Control Plane compatibility and remote consumption

## Published contract

`@octopus-reef/control-plane` 0.1.1 is the first public execution-control-plane
release. It publishes three independent contracts:

- the deployment-neutral ports, state machine, worker and typed HTTP client;
- HTTP Run API v1 at `/v1/runs` and cursor-based SSE events;
- `ghcr.io/octoryn/octopus-reef-control-plane`, whose default supported
  entrypoint is `reef-control-plane serve`.

Pin npm to an exact version in production. Pin the service image by the
`sha256:` digest recorded in the `control-plane-v0.1.1` GitHub Release, not only
by its human-readable `0.1.1` tag. npm versions and release image tags are never
overwritten by the release workflow.

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

| Dependency | Compatible line |
| --- | --- |
| `@octopus-reef/agent` | `^0.2.2` (checkpoint/resume) |
| `@octopus-reef/engine` | `^0.2.1` (tool idempotency) |
| `@octopus-reef/protocol` | `^0.1.1` (decimal cursor events) |
| `@octopus-reef/adapter-runtime` | `^0.1.0` |
| `octopus-workstate` / `octopus-evidence` | `^0.2.0` |
| `octopus-runtime` | `^0.7.0` |

`OctopusIntentAcceptanceVerifier` accepts the official `checkContract`
function through a typed injection seam. This deliberately avoids a sibling
source import or a local `file:` dependency while still using the authoritative
checker selected by the deployment.

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

Schema migration `0002_remote_contract` adds the immutable baseline and typed
candidate result references. Apply `reef-control-plane migrate` before rolling
out 0.1.1, or set `REEF_CONTROL_PLANE_AUTO_MIGRATE=true` for the reference
single-service deployment.

`AgentExecutionState` is the closed 0.1.1 union `QUEUED | PROVISIONING |
PLANNING | RUNNING | WAITING_FOR_TOOL | VERIFYING | WAITING_FOR_REVIEW |
COMPLETED | FAILED | CANCELLED | BUDGET_EXCEEDED`. Builder may project these
into product wording, but must not treat an execution state as Project State.

## Minimal remote API deployment

The reference Compose file starts PostgreSQL and the official API image. Read
the exact digest from the GitHub Release, then run:

```sh
export REEF_CONTROL_PLANE_IMAGE='ghcr.io/octoryn/octopus-reef-control-plane@sha256:<release-digest>'
docker compose -f examples/control-plane/docker-compose.yml up -d
curl --fail http://127.0.0.1:8080/healthz
```

The image contains the deployment-neutral HTTP service and PostgreSQL adapter.
Horizontally scaled workers are separate processes composed from the published
`ControlPlaneWorker` with the chosen queue, sandbox, artifact, Git, secret and
model-provider adapters. This separation keeps provider credentials and sandbox
privileges out of the public API process. For production, place the API behind
TLS and authentication that derives the two tenant headers from the verified
identity; never trust tenant headers supplied directly by an Internet client.
