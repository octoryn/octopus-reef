# @octopus-reef/verification

`@octopus-reef/verification` is Reef's deterministic Verification Run runtime.
It is independent from `AgentRun`: it does not load a model, Agent kernel, Git
workspace, or review/approval workflow.

The formal 0.3 API is also exposed by
`@octopus-reef/control-plane@0.3.0/verification` and its subpaths. Consumers
that use the Builder compatibility contract should pin
`@octopus-reef/control-plane@0.3.0` exactly. The control-plane package declares
an exact dependency on this package at 0.3.0; a workspace-only package is not a
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

### External materialization contract

The stable deployment-neutral boundary is `ExternalMaterializationPort` with
contract version `1.0.0`. `DeterministicSourceBundleMaterializer` accepts that
Port directly. `SourceBundleStoreMaterializationBridge` adapts a trusted local,
ArtifactStore, or S3-backed server-side store without exposing its location or
credentials. It is available from both
`@octopus-reef/verification/materialization` and
`@octopus-reef/control-plane/verification/materialization`.

The Port request schema is
`octopus.reef.external-materialization-request/v1`. It contains exactly the
full organisation/project/candidate/source/profile/run identity and the
positive attempt. All refs are bounded opaque refs. URL, URI, bucket, key,
command, argv, cwd, environment, raw credential, and caller-chosen secret-ref
fields are absent and rejected. Storage location, authentication, and routing
are trusted deployment configuration only.

The resolved inventory is the Builder-owned,
candidate-bound `octopus.builder.source-bundle/v1` contract:

```ts
{
  schemaVersion: "octopus.builder.source-bundle/v1";
  organisationRef: string;
  projectRef: string;
  candidateRef: string;
  candidateDigest: `sha256:${string}`;
  sourceBundleRef: string;
  sourceBundleDigest: `sha256:${string}`;
  unicodeNormalization: "NFC";
  pathSemantics: "portable-nfc-casefold-v1";
  entries: Array<{
    kind: "file";
    path: string;
    size: number;
    digest: `sha256:${string}`;
  }>;
}
```

Reef verifies but never redefines `sourceBundleDigest`. Its canonical input is
the inventory above without `sourceBundleDigest`, in the displayed field
structure, hashed as lowercase `sha256:` plus the `octopus-evidence`
`canonicalHash`. Entries must be uniquely ascending by their UTF-8 path bytes.
Paths must already be NFC relative `/` paths. The exact
`portable-nfc-casefold-v1` collision key is
`NFC(lowercase(uppercase(NFC(path))))` using locale-independent ECMAScript
Unicode casing.

The default limits are 20,000 files, 16 MiB per file, 512 MiB total, and 1,024
UTF-8 bytes per path. Empty inventories, unsafe integers, duplicate or
case-fold-ambiguous paths, absolute/traversal/backslash paths, trailing dot or
space segments, control characters, symlinks, hardlinks, FIFO/device/socket
entries, size drift, and content digest drift fail closed. Every object is
staged and verified before sandbox writes; a failed atomic write cleans only
files created by that materialization call.

Reef independently generates
`octopus.reef.materialization-descriptor/v1`. Its canonical digest covers
contract version `1.0.0`, the full run identity, attempt, authoritative Builder
ref/digest, exact policy limits, and validated entries. The Run, materialized
event, persistence columns, typed client, and Evidence expose only:

```ts
{
  schemaVersion: "octopus.reef.materialization/v1";
  ref: `materialization:${string}`;
  runtimeDescriptorDigest: `sha256:${string}`;
  authoritativeSourceBundleDigest: `sha256:${string}`;
  entryCount: number;
  totalBytes: number;
}
```

The materialization ref suffix must equal the runtime descriptor digest suffix.
The authoritative source-bundle digest and runtime descriptor digest are
distinct identities and are never substituted for one another. Restart
recomputes and verifies the same descriptor; a different descriptor,
cross-tenant response, or stale-attempt replay is rejected. Public payloads do
not contain local paths, source content, customer data, storage locators, or
secrets.

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
the verification subpaths does not alias or reinterpret an AgentRun.

Version 0.3.0 requires an exact, coordinated upgrade from 0.2.2. The HTTP
creation identity and endpoint remain v1, but the Worker source-materialization
input changes to the Builder-owned `octopus.builder.source-bundle/v1`
inventory, canonical cursors are enforced at every boundary, and successful
new runs persist materialization identity. There is intentionally no legacy
descriptor reader, version range, or fallback. Migrate PostgreSQL to
`0002_materialization`, drain or cancel non-terminal 0.2.2 runs, install both
0.3.0 packages exactly, populate the Builder v1 inventory, then roll API and
Worker together. Historical terminal runs and Evidence without materialization
remain readable.

The complete ordered cutover and rollback constraints are documented in
`docs/DETERMINISTIC-VERIFICATION-0.3-MIGRATION.md`.

Release candidates must pass the checked-in pre-publish gate, real PostgreSQL
and isolated Docker acceptance, clean tarball installation, package/image
scans, SBOM and provenance generation, and independent black-box review. A
partially published package, tag, image, or release record is not compatible.
