# Agent Execution Control Plane

`@octopus-reef/control-plane` turns the existing Agent Kernel into a durable,
recoverable, horizontally scalable service. It composes rather than replaces:

```text
Run API / SSE
      |
ControlPlaneService -- repository / event / queue / review ports
      |
ControlPlaneWorker -- lease + heartbeat + fence + budget + checkpoint
      |
ReefAgentKernel
      +-- @octopus-reef/agent (the existing agent loop)
      +-- @octopus-reef/engine (governed execution and evidence)
      +-- octopus-workstate / octopus-evidence
      +-- octopus-intent AcceptanceVerifier
      +-- octopus-runtime-compatible Authorizer
```

The core has no AWS imports outside `src/adapters/aws.ts`. AWS deployments may
select SQS, S3 and Fargate; a local deployment may select PostgreSQL's queue and
Docker. Both use the same ports and state machine.

## Recovery invariant

A kernel checkpoint callback is awaited before the existing AgentWorker loop
advances. `TOOL_INTENT` creates an idempotent step before execution;
`TOOL_RESULT` completes that step and stores the resumable conversation before
another model request. If a process dies after that write, the next fenced owner
loads the checkpoint, skips the completed tool, and continues the same loop.

Queue transports remain intentionally at-least-once. PostgreSQL owns execution
with an expiring lease and monotonically increasing fencing token. Every state,
step and checkpoint mutation checks the current token. An old worker therefore
cannot commit after a takeover, even if it wakes up late.

## API

- `POST /v1/runs`
- `GET /v1/runs/:id`
- `GET /v1/runs/:id/events` (`cursor` or `Last-Event-ID`)
- `POST /v1/runs/:id/pause`
- `POST /v1/runs/:id/resume`
- `POST /v1/runs/:id/retry`
- `POST /v1/runs/:id/cancel`
- `POST /v1/runs/:id/approve`
- `POST /v1/runs/:id/reject`

All routes require authenticated tenancy to be projected into
`x-organisation-id` and `x-project-id` by the deployment's auth layer.

Example creation body:

```json
{
  "task": "implement the accepted work item",
  "idempotencyKey": "builder-job-018f",
  "projectRef": "project://opaque/4d9b",
  "baselineRevisionRef": "git-revision://opaque/923ea4",
  "workItemRef": "work-item://opaque/91e2",
  "acceptanceRef": "acceptance://opaque/31aa",
  "secretRefs": [
    { "name": "modelApiKey", "secretRef": "aws-secrets://reef/model-prod" }
  ],
  "budget": {
    "maxTokens": 100000,
    "maxCostUsd": 25,
    "maxWallTimeMs": 3600000,
    "maxToolCalls": 200,
    "maxOutputBytes": 10000000
  }
}
```

Every command body also carries an `idempotencyKey`; the supported client sends
the same value in `Idempotency-Key`. Completed runs expose candidate-only
`resultRefs` with optional `diffRef` and `testRef` plus `evidenceRefs`. These
references are evidence for the caller's own review boundary, not authority to
approve a deliverable or change an external project lifecycle.

Plaintext `apiKey`, `password`, `secret`, access-token or credential fields in
config/metadata are rejected.

The supported remote client, release compatibility rules, immutable image
contract and minimal Compose deployment are in
[`CONTROL-PLANE-COMPATIBILITY.md`](./CONTROL-PLANE-COMPATIBILITY.md).
