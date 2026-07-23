# @octopus-reef/verification

`@octopus-reef/verification` is Reef's deterministic Verification Run runtime.
It is independent from `AgentRun`: it does not load a model, Agent kernel, Git
workspace, or review/approval workflow.

The formal 0.4 API is also exposed by
`@octopus-reef/control-plane@0.4.0/verification` and its subpaths. Consumers
that use the Builder compatibility contract should pin
`@octopus-reef/control-plane@0.4.0` exactly. The control-plane package declares
an exact dependency on this package at 0.4.0; a workspace-only package is not a
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

The stable deployment-neutral boundary is `ExternalMaterializationPort`.
`DeterministicSourceBundleMaterializer` accepts that
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

The published
`@octopus-reef/verification/adapters/builder-source-bundle-s3` subpath reads
Builder's existing descriptor-first, content-addressed blob layout. Its
deployment-owned resolver supplies bucket, prefix, and expected bucket owner;
the external request cannot select any of them. The adapter derives tenant and
bundle keys from the exact Builder v1 algorithm, validates the descriptor
before any blob, and then validates every blob's path, byte count, and digest.

The resolved descriptor is exactly the Builder-owned
`octopus.builder.source-bundle/v1` wire contract:

```ts
{
  schemaVersion: "octopus.builder.source-bundle/v1";
  organisationRef: string;
  projectRef: string;
  bundleRef: `source-bundle:sha256:${string}`;
  digest: `sha256:${string}`;
  inventory: Array<{
    path: string;
    contentDigest: `sha256:${string}`;
    sizeBytes: number;
  }>;
}
```

The authoritative Builder digest is SHA-256 of UTF-8
`JSON.stringify({schemaVersion:"octopus.builder.source-bundle/v1",files})`,
where `files` is path-sorted with ECMAScript string `<`/`>` and every object is
inserted in `path,contentDigest,sizeBytes` property order. Reef verifies these
exact bytes and requires `bundleRef === "source-bundle:" + digest`; it never
relabels, recomputes into a Reef schema, or replaces this identity. The
candidate is bound separately.

Reef generates
`octopus.reef.builder-source-bundle-binding/v1` over the exact
organisation/project/candidate/source tuple and
`{unicodeNormalization:"NFC",pathSemantics:"portable-nfc-casefold-v1"}`.
`bindingDigest` is lowercase `sha256:` plus `octopus-evidence@0.2.0`
`canonicalHash` of the displayed binding fields excluding `bindingRef` and
`bindingDigest`; the ref is
`builder-source-bundle-binding:<binding-digest-hex>`.

Inventory paths must be uniquely ascending by the Builder v1 string rule.
Paths must already be NFC relative `/` paths. The exact
`portable-nfc-casefold-v1` collision key is
`NFC(lowercase(uppercase(NFC(path))))` using locale-independent ECMAScript
Unicode casing.

The default limits are 10,000 files, 16 MiB per file, 128 MiB total, and 1,024
UTF-8 bytes per path. Empty inventories, unsafe integers, duplicate or
case-fold-ambiguous paths, absolute/traversal/backslash paths, trailing dot or
space segments, control characters, symlinks, hardlinks, FIFO/device/socket
entries, size drift, and content digest drift fail closed. Every object is
staged and verified before sandbox writes; a failed atomic write cleans only
files created by that materialization call.

Reef independently generates
`octopus.reef.materialization-descriptor/v2`. Its canonical digest is lowercase
`sha256:` plus `octopus-evidence@0.2.0` `canonicalHash` over the descriptor
excluding `descriptorDigest`. It covers contract version `2.0.0`, full run
identity, attempt, authoritative Builder ref/digest, Reef binding ref/digest,
exact policy limits, and validated inventory. The Run, materialized
event, persistence columns, typed client, and Evidence expose only:

```ts
{
  schemaVersion: "octopus.reef.materialization/v2";
  ref: `materialization:${string}`;
  runtimeDescriptorRef: `materialization-descriptor:${string}`;
  runtimeDescriptorDigest: `sha256:${string}`;
  builderSourceBundleRef: `source-bundle:sha256:${string}`;
  builderSourceBundleDigest: `sha256:${string}`;
  builderSourceBundleBindingRef: `builder-source-bundle-binding:${string}`;
  builderSourceBundleBindingDigest: `sha256:${string}`;
  entryCount: number;
  totalBytes: number;
}
```

The materialization ref suffix must equal the runtime descriptor digest suffix.
The authoritative Builder digest, Reef binding digest, and runtime descriptor
digest are three distinct identities and are never substituted. Restart
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

Version 0.4.0 is a breaking correction to 0.3.0. The 0.3 runtime used the
Builder-owned schema name for a different extended object and digest meaning.
That shape is incompatible and superseded: 0.4 has no fallback, duck typing,
relabel, or automatic reinterpretation. Drain or cancel all non-terminal 0.3
runs under the immutable 0.3 runtime, migrate PostgreSQL to
`0003_builder_v1_binding`, install both 0.4.0 packages exactly, configure the
trusted Builder v1 source adapter, then roll API and Worker together. Historical
0.3 rows remain byte-preserved; a 0.4 worker refuses to process their colliding
materialization identity.

The complete ordered cutover and rollback constraints are documented in
`docs/DETERMINISTIC-VERIFICATION-0.4-MIGRATION.md`.

Release candidates must pass the checked-in pre-publish gate, real PostgreSQL
and isolated Docker acceptance, clean tarball installation, package/image
scans, SBOM and provenance generation, and independent black-box review. A
partially published package, tag, image, or release record is not compatible.
