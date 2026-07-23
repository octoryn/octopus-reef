# Deterministic Verification 0.2.2 to 0.3.0 migration

## Compatibility decision

Version 0.3.0 is an exact coordinated upgrade:

```text
@octopus-reef/control-plane@0.3.0
@octopus-reef/verification@0.3.0
control-plane-v0.3.0
```

The control-plane package depends on verification exactly at 0.3.0. Builder
must not use a range, local workspace, sibling source import, copied runtime,
or fallback to a 0.2.x source descriptor. API and Worker must run the same
0.3.0 commit and image set.

The `/v1/verifications` create identity remains v1. AgentRun remains separate
and unchanged. Verification still has no pause, resume, approve, reject,
AgentKernel, model, Git, or review-product dependency.

## What changes

- Every cursor boundary accepts only `0` or `[1-9][0-9]*` as an exact string.
  Existing canonical cursors remain valid; normalized or numeric cursors do
  not.
- The Worker accepts only the Builder-owned, candidate-bound
  `octopus.builder.source-bundle/v1` neutral inventory. The former Reef
  descriptor is not read.
- New successful materializations record
  `octopus.reef.materialization/v1` identity on the Run, event, persistence
  columns, typed client, and Evidence.
- PostgreSQL schema head advances from `0001_verification` to
  `0002_materialization`. The new columns are nullable so historical terminal
  0.2.2 runs remain readable.
- Evidence resolution now binds requested ref, returned ref, Evidence id,
  canonical digest, full run identity, and materialization identity.

## Ordered cutover

1. Pin and retain the complete 0.2.2 deployment identity for rollback. Back up
   PostgreSQL and the trusted source/Evidence/artifact stores.
2. Stop new 0.2.2 verification creation. Drain all non-terminal runs or cancel
   them with a durable product decision. Do not leave queued/running 0.2.2 runs
   for a 0.3.0 Worker because their source inventory is incompatible.
3. Materialize every future Builder candidate as the exact
   `octopus.builder.source-bundle/v1` inventory. Keep the Builder
   `sourceBundleDigest` authoritative; do not replace it with Reef's runtime
   descriptor digest.
4. Run the 0.3.0 `reef-verification migrate` entrypoint. It serializes migration
   entrypoints and applies `0001_verification`, then `0002_materialization`.
   Re-running it is required to be idempotent.
5. Verify schema head `0002_materialization` and the migration-set digest from
   the matching GitHub Release bundle.
6. Deploy the exact 0.3.0 API and Worker manifests together. Register the exact
   Release profile ref/version/digest and its matching Golden image digest.
7. Configure workload authentication from a deployment-owned offline JWKS.
   The verified principal contract is a non-empty subject, one exact
   `organisationRef`, an explicit `projectRefs` membership list, and only the
   closed `verification:*` permission set. Request tenant headers must exactly
   match that principal.
8. Require `GET /health/live` to return HTTP 200 with `{"status":"live"}` and
   `GET /health/ready` to return HTTP 200 with `{"status":"ready"}` after
   PostgreSQL readiness and migration checks.
9. Create one canary using the Builder v1 inventory, persist its cursor as a
   string, reconnect at its exact terminal cursor, resolve its Evidence, and
   verify the Run/Evidence materialization refs and both distinct digests.
10. Re-enable creation only after the canary is complete.

## Rollback boundary

Migration `0002_materialization` is additive and may remain installed. A 0.2.2
Worker must not consume a candidate created for 0.3.0, and 0.3.0 runs must not
be rewritten into the legacy descriptor. If rollback is necessary, stop
creation and Workers, preserve all 0.3.0 rows and objects, restore the complete
0.2.2 API/Worker/profile/image set, and accept only newly created 0.2.2
candidates. Do not delete materialization columns, rewrite Evidence, coerce
cursors, or reuse idempotency keys with changed identity.

Historical 0.2.2 terminal runs and Evidence without a materialization field are
read-compatible in 0.3.0. This is not a dual-write or fallback promise for new
work.
