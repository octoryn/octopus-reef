# Deterministic Verification 0.4.0 to 0.4.1

Version 0.4.1 is a security and data-integrity patch. It does not change the
Builder v1 descriptor, Reef binding, runtime descriptor, HTTP, typed-client, or
Evidence wire contracts published by 0.4.0. It replaces the PostgreSQL
materialization identity constraint because the 0.4.0 expression could
evaluate to SQL `UNKNOWN`; PostgreSQL accepts `UNKNOWN` for a `CHECK`.

The 0.4.0 tag, packages, images, Release, and history remain immutable. Do not
move, overwrite, or reinterpret them. Pin the 0.4.1 pair exactly:

```text
@octopus-reef/control-plane@0.4.1
@octopus-reef/verification@0.4.1
```

Control Plane declares an exact dependency on Verification 0.4.1. Builder must
not use a range, workspace fallback, copied implementation, or 0.4.0 runtime
fallback.

## Schema head

The 0.4.1 schema head is
`0004_materialization_identity_total_check`. The migration drops and recreates
`verification_runs_materialization_identity_check` as an explicitly total
boolean expression:

- an all-NULL 11-column identity is accepted;
- a complete historical v1 identity has exactly its six required columns
  non-NULL and all five v2-only columns NULL;
- a complete v2 identity has all 11 columns non-NULL;
- every partial tuple, unknown schema, malformed ref/digest, digest mismatch,
  zero entry count, or negative byte count evaluates to `FALSE`, never
  `UNKNOWN`, and fails with PostgreSQL SQLSTATE `23514`.

The migration validates existing rows while adding the constraint. It does not
repair, delete, relabel, or reinterpret an invalid partial tuple. If migration
fails, keep API and Worker stopped, identify the affected run through
deployment-controlled operational procedures, and resolve it under an
explicitly reviewed data-recovery plan before retrying.

## Ordered upgrade

1. Drain or stop 0.4.0 API and Worker processes that write
   `verification_runs`.
2. Take a database backup using the deployment's normal recovery procedure.
3. Install both 0.4.1 packages exactly and pin the API, Worker, and Golden Stack
   images by the manifest digests in the 0.4.1 Release.
4. Run `reef-verification migrate` once. Repeated or concurrent migration
   entrypoints are safe because Reef serializes the ordered migration set with
   a database-local transaction advisory lock.
5. Verify readiness reports schema head
   `0004_materialization_identity_total_check`.
6. Start the 0.4.1 API and Worker together. Preserve exact Builder authoritative
   bundle ref/digest, Reef binding ref/digest, runtime descriptor ref/digest,
   profile ref/version/digest, and canonical decimal cursors.

Upgrades from 0.3.0 apply 0003 and 0004 in order. Historical complete v1 rows
remain byte-preserved and continue to require the immutable 0.3 runtime for
interpretation. Upgrades from 0.4.0 apply only the new logical schema head after
the runtime replays the exact ordered migration bytes.

## Rollback

There is no supported downgrade that removes 0004. If application rollback is
required, keep the stricter constraint and restore only an explicitly pinned
runtime that understands the existing persisted rows. A database rollback
requires restoring the pre-upgrade backup; never weaken the constraint in
place or write a partial identity tuple.

The Release bundle publishes all four exact SQL assets, their individual
digests, the ordered migration-set digest, candidate/test summaries, SBOMs,
scan evidence, npm identities, OCI manifests, trusted profile identity, and
known-unverified list. Successful upstream gates mean
`READY FOR FRESH INDEPENDENT AUDIT`, not Builder GO.
