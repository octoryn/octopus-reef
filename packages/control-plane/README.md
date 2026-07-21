# @octopus-reef/control-plane

A deployment-neutral execution control plane around the existing Reef Agent
Kernel. It does **not** implement an agent loop. `ReefAgentKernel` runs the
existing `@octopus-reef/agent` `AgentWorker` through
`@octopus-reef/engine`'s `GovernedSession`; this package owns only durable run
lifecycle, scheduling, recovery and production boundaries.

## Boundaries

- Core ports and worker contain no AWS or Octopus Builder dependency.
- Callers pass only opaque `projectRef`, `workItemRef` and `acceptanceRef` values.
- The Run API rejects plaintext credential-shaped config and accepts
  `secretRefs` only. A worker resolves those references after it owns a fenced
  lease; resolved values never enter events or checkpoints.
- Every repository call includes `organisationId` + `projectId`. PostgreSQL uses
  tenant columns in every primary/foreign/unique key and query. Local/S3
  workspaces and artifacts use tenant-derived prefixes.

## Durable execution

`AgentWorker` exposes an awaited checkpoint/resume seam at model response, tool
intent and tool result boundaries. The control-plane worker additionally stores
verification checkpoints. Semantic idempotency keys, step uniqueness and a
monotonic repository fencing token make duplicate queue delivery harmless and
let a new worker safely take an expired lease.

PostgreSQL migration: `migrations/0001_control_plane.sql`.

Reference adapters:

- PostgreSQL run/step/checkpoint/event/outbox and `SKIP LOCKED` queue
- AWS SQS queue, S3 artifacts and ECS/Fargate sandbox provisioning
- Local and hardened Docker sandbox provisioning
- Git branch/worktree/commit workspace

Import the neutral core from `@octopus-reef/control-plane`. Adapters are
explicit subpaths: `@octopus-reef/control-plane/adapters/postgres`,
`@octopus-reef/control-plane/adapters/aws`, and
`@octopus-reef/control-plane/adapters/local`. The main entrypoint does not load
AWS SDK or PostgreSQL modules.

The published typed HTTP client is available at
`@octopus-reef/control-plane/client`. It covers run creation and lookup,
pause/approve/reject commands, tenant headers, exact decimal SSE cursors,
reconnect/deduplication, and typed protocol/network/HTTP failures.

The service image uses `reef-control-plane serve` as its supported entrypoint.
It requires `REEF_CONTROL_PLANE_DATABASE_URL`, listens on port 8080 by default,
and exposes `/healthz`. `reef-control-plane migrate` applies schema migrations
without starting HTTP. Pin the image by the digest in the matching GitHub
Release.

Compatibility and a remote deployment example are documented in
`docs/CONTROL-PLANE-COMPATIBILITY.md`.

Reef review approval is scoped to an `AgentRun`: it may resume that run, but it
never approves a Builder deliverable or advances Builder Project State. Builder
integrates through its server-side `AgentRuntimePort` and opaque references
only.

The Docker reference uses `--network none`, a read-only root filesystem,
`--cap-drop ALL`, `no-new-privileges`, an unprivileged uid, resource limits, a
single workspace bind mount, and `AWS_EC2_METADATA_DISABLED=true`.
