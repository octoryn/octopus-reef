# @octopus-reef/verification

`@octopus-reef/verification` is Reef's deterministic Verification Run runtime.
It is independent from `AgentRun`: it does not load a model, Agent kernel, Git
workspace, or review/approval workflow.

The formal 0.2 API is also exposed by
`@octopus-reef/control-plane@0.2.1/verification` and its subpaths. Consumers
that use the Builder compatibility contract should pin
`@octopus-reef/control-plane@0.2.1` exactly. The control-plane package declares
an exact dependency on this package at 0.2.1; a workspace-only package is not a
compatible release.

## Public contract

The HTTP API is versioned at `/v1/verifications`. The typed client is exported
from `@octopus-reef/control-plane/verification/client` and provides:

- `createRun`
- `getRun`
- `streamRunEvents`
- `retryRun`
- `cancelRun`
- `resolveEvidence`

Creation accepts exactly the tenant, candidate, source-bundle, immutable
profile, and idempotency identity fields declared by `VerificationRunRequest`.
Unknown fields are rejected. There is no public `command`, `argv`, `cwd`,
environment, raw credential, pause, approve, or reject input.

All non-health endpoints require a verified RS256 workload JWT. Tenant headers
are selectors only: the Organisation, Project, and route permission must be
bound by the verified principal. The verifier reads a deployment-owned JWKS
file and never follows a token- or network-provided key URL.

SSE cursors are canonical, exact decimal strings. Events durably echo the full
request identity. The client validates every JSON and SSE response at runtime,
deduplicates reconnects, and terminates cleanly when a terminal run's exact
cursor has been consumed.

## State and Evidence

A check failure is a successfully executed verification:

```text
state = completed
verdict.outcome = failed
```

Only infrastructure, isolation, source, profile, or protocol failures use the
operational `failed` state and product-safe retryable failure metadata.

Every check and final verdict is a real `octopus-evidence` record. Evidence
binds the exact tenant, candidate, source bundle, profile, run version, attempt,
check coverage, and artifact digests. Resolution is tenant-scoped and
store-untrusting: both Evidence integrity and its advertised canonical digest
are recomputed before the response is returned. The typed client repeats those
checks locally.

## Trusted inputs and isolation

Profiles are server-registered by exact ref, semantic version, and canonical
digest. They contain reviewed typed argv, bounded working directories,
environments, secrets, tools, artifacts, and execution budgets. Mutable aliases,
unknown fields, process-injection environment variables, and digest drift fail
closed.

`createGoldenStackProfile(imageDigest)` is the first-party Golden Stack schema
baseline. The Release publishes the real Next.js/FastAPI/PostgreSQL remote
sandbox as an immutable multi-architecture image and attaches the authoritative
full profile JSON. The release profile may advance its own immutable patch
version when deployment-only wiring changes; consumers use the exact
ref/version/digest tuple in the Release, not a locally regenerated assumption.
The release record binds both the profile's canonical digest and its sandbox
image manifest digest. Test-only smoke profiles and placeholder digests are
never a published deployment contract.

Source bundles use the documented `reef.source-bundle.v1` descriptor and NFC
Unicode normalization. Materialization verifies the tenant, descriptor digest,
inventory, every file size and digest, total limits, path confinement, duplicate
and case-ambiguous names, and regular-file storage. URLs, archive extraction,
absolute/traversal/backslash paths, symlinks, and hardlinks are rejected.

Production uses PostgreSQL for durable runs, exact cursors, checkpoints,
transactional outbox, queue leases, and fencing. The Worker checks its fence
before every artifact/Evidence publication and durable mutation. Cancellation
or observed lease loss aborts the active child process.

## Entrypoints

```text
reef-verification migrate
reef-verification api
reef-verification worker
```

The API and Worker images are separate release artifacts and must be pinned by
manifest digest. The Worker manifest must include `linux/amd64` and
`linux/arm64`. Mutable tags are not a supported deployment identity.

The Release also publishes a remote Golden Stack sandbox manifest. Its default
command is the authenticated port-8081 bridge consumed by
`AwsEcsVerificationSandboxProvisioner`; the local Docker adapter overrides that
command and uses the same immutable toolchain through `docker exec`. A plain
tool image whose default command only sleeps is not a deployable Fargate
sandbox. Pin the server-registered profile JSON and its remote sandbox digest
from the Release record as one identity.

The AWS task definition, least-privilege roles, network boundary, and complete
configuration-name inventory are documented in
`docs/DETERMINISTIC-VERIFICATION-AWS.md`.

## Compatibility

The existing 0.1.x AgentRun surface remains separate and unchanged. Importing
the verification subpaths does not alias or reinterpret an AgentRun. The 0.2.1
minor release adds the new Verification Run product surface; later patch
releases may make backward-compatible fixes, while request/state/Evidence
schema breaks require a new API and package minor or major version.

Release candidates must pass the checked-in pre-publish gate, real PostgreSQL
and isolated Docker acceptance, clean tarball installation, package/image
scans, SBOM and provenance generation, and independent black-box review. A
partially published package, tag, image, or release record is not compatible.
