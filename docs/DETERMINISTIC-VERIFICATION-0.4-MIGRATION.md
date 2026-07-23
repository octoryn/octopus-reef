# Deterministic Verification 0.3.0 to 0.4.0

Version 0.4.0 is an intentional breaking correction. Version 0.3.0 used the
Builder-owned name `octopus.builder.source-bundle/v1` for a Reef extension with
a different shape and digest meaning. Builder already owns and publishes that
name. The two contracts cannot be made compatible by relabelling or
recalculation.

## Exact package and schema identity

Pin both packages without a range or workspace fallback:

```text
@octopus-reef/control-plane@0.4.0
@octopus-reef/verification@0.4.0
```

Control Plane declares an exact dependency on Verification 0.4.0. The
Verification database schema head is `0003_builder_v1_binding`.

Builder v1 remains exactly:

```ts
{
  schemaVersion: "octopus.builder.source-bundle/v1";
  organisationRef: string;
  projectRef: string;
  bundleRef: string;
  digest: `sha256:${string}`;
  inventory: Array<{
    path: string;
    contentDigest: `sha256:${string}`;
    sizeBytes: number;
  }>;
}
```

Its digest is SHA-256 of UTF-8
`JSON.stringify({schemaVersion:"octopus.builder.source-bundle/v1",files})`.
`files` is sorted by ECMAScript string `<`/`>` on path and every object is
inserted in `path,contentDigest,sizeBytes` order. `bundleRef` must equal
`"source-bundle:" + digest`.

Reef candidate/path-policy identity uses the separate
`octopus.reef.builder-source-bundle-binding/v1` schema. Runtime identity uses
`octopus.reef.materialization-descriptor/v2` and public
`octopus.reef.materialization/v2`. Builder digest, Reef binding digest, and
runtime descriptor digest never replace one another.

## Ordered cutover

1. Keep the immutable 0.3.0 API and Worker available while draining or
   cancelling every non-terminal 0.3 run. Do not let a 0.4 Worker claim a 0.3
   materialization.
2. Preserve the 0.3.0 tag, packages, images, Release, and database rows exactly.
   Migration 0003 is additive and does not rewrite historical 0.3 identity.
3. Run `reef-verification migrate` from the exact 0.4.0 image and verify schema
   head `0003_builder_v1_binding` plus the Release migration-set digest.
4. Configure the server-owned Builder source adapter:

   ```text
   REEF_VERIFICATION_BUILDER_SOURCE_S3_BUCKET
   REEF_VERIFICATION_BUILDER_SOURCE_S3_PREFIX
   REEF_VERIFICATION_BUILDER_SOURCE_S3_EXPECTED_BUCKET_OWNER
   ```

   Bucket, prefix, keys, URLs, credentials, and secret refs never appear in a
   materialization request.

5. Roll the 0.4.0 API and Worker together by the exact multi-architecture
   manifest digests recorded in the 0.4.0 Release.
6. Submit the frozen Builder v1 golden descriptor and verify exact echo of
   `bundleRef/digest`, a distinct Reef binding ref/digest, a distinct runtime
   descriptor ref/digest, canonical decimal cursors, and store-untrusting
   Evidence.

There is no 0.3 descriptor fallback, duck typing, or automatic reinterpretation.
A 0.4 process encountering persisted
`octopus.reef.materialization/v1` fails with an explicit incompatibility error.
Use the immutable 0.3 runtime only to drain that historical work.

## Rollback

Before accepting a 0.4 run, API and Worker may both roll back to the exact 0.3
deployment. Migration 0003 may remain installed because its columns are
additive and preserve the 0.3 constraint branch. After accepting a 0.4
materialization, do not route it to a 0.3 Worker. Roll forward with the same
0.4 package/image/tag identities; never republish or move either release.
