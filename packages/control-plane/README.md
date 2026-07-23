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

PostgreSQL migrations: `migrations/0001_control_plane.sql` through
`migrations/0003_transactional_dispatch.sql`.

Reference adapters:

- PostgreSQL run/step/checkpoint/event/outbox, transactional dispatch outbox and
  `SKIP LOCKED` queue
- AWS SQS queue, Secrets Manager, S3 artifacts and ECS/Fargate sandbox
  provisioning
- Local and hardened Docker sandbox provisioning
- Git branch/worktree/commit workspace

Import the neutral core from `@octopus-reef/control-plane`. Adapters are
explicit subpaths: `@octopus-reef/control-plane/adapters/postgres`,
`@octopus-reef/control-plane/adapters/aws`, and
`@octopus-reef/control-plane/adapters/local`. The main entrypoint does not load
AWS SDK or PostgreSQL modules.

The published typed HTTP client is available at
`@octopus-reef/control-plane/client`. It covers create/get, pause, resume,
retry, cancel, approve and reject; every mutation carries an idempotency key.
It also preserves tenant headers, exact decimal SSE cursors,
reconnect/deduplication, typed execution states, candidate
`diffRef`/`testRef`/`evidenceRefs`, and typed protocol/network/HTTP failures.
Creation pins an opaque immutable `baselineRevisionRef`.

The immutable API, Worker and sandbox images use `reef-control-plane api`,
`reef-control-plane worker`, and `reef-sandbox-runner`; `serve` remains an API
alias.
`reef-control-plane migrate` applies schema migrations without starting HTTP.
The API exposes liveness at `/healthz` and database/schema readiness at
`/readyz`. Pin each image by its separate digest in the matching GitHub Release.

The Worker entrypoint wires PostgreSQL/SQS queues, env/Secrets Manager secrets,
local/S3 artifacts, local/Docker/ECS sandboxes, Git worktrees, and the existing
Anthropic, Bedrock bearer-token and Bedrock IAM/SigV4 `ModelProvider`
implementations. `bedrock-iam` uses the Fargate task role and requires no model
credential `secretRef`. Every official image includes the checksum-pinned AWS
RDS global CA bundle at `/etc/ssl/certs/aws-rds-global-bundle.pem`; setting
`REEF_CONTROL_PLANE_DATABASE_SSL_MODE=verify-full` uses that fixed path unless
an explicit CA file/base64 override is supplied.

The ECS adapter defaults to the private HTTP runner inside each sandbox task;
it no longer requires `REEF_ECS_COMMAND_ENDPOINT`. Configure a Worker-only
`REEF_ECS_RUNNER_SHARED_SECRET`, task definition, private subnets and sandbox
security group. The legacy external bridge endpoint remains supported for
existing deployments. See `docs/CONTROL-PLANE-AWS.md` for the task definition,
network isolation and minimum IAM policy.

Compatibility and a remote deployment example are documented in
`docs/CONTROL-PLANE-COMPATIBILITY.md`.

## Deterministic Verification Runs in 0.2.1

`@octopus-reef/control-plane@0.2.1` formally exposes the separate verification
runtime from `@octopus-reef/control-plane/verification`, with its typed client
at `@octopus-reef/control-plane/verification/client` and production adapters at
the corresponding `verification/*` subpaths. The package declares the exact
compatible `@octopus-reef/verification@0.2.1` dependency.

The versioned `/v1/verifications` contract uses the canonical client methods
`createRun`, `getRun`, `streamRunEvents`, `retryRun`, and `cancelRun`. It accepts
only opaque candidate/source/profile identity and never aliases an AgentRun or
accepts caller commands, argv, cwd, environment, or credentials. Existing
0.1.x AgentRun clients remain on their prior endpoints and client surface.

Reef review approval is scoped to an `AgentRun`: it may resume that run, but it
never approves a Builder deliverable or advances Builder Project State. Builder
integrates through its server-side `AgentRuntimePort` and opaque references
only.

The Docker reference uses `--network none`, a read-only root filesystem,
`--cap-drop ALL`, `no-new-privileges`, an unprivileged uid, resource limits, a
single workspace bind mount, and `AWS_EC2_METADATA_DISABLED=true`.
