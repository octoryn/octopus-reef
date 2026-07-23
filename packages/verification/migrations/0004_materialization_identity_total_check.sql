ALTER TABLE verification_runs
  DROP CONSTRAINT IF EXISTS verification_runs_materialization_identity_check;

ALTER TABLE verification_runs
  ADD CONSTRAINT verification_runs_materialization_identity_check
  CHECK (
    (
      CASE
        WHEN num_nonnulls(
          materialization_schema_version,
          materialization_ref,
          materialization_descriptor_ref,
          materialization_descriptor_digest,
          authoritative_source_bundle_digest,
          builder_source_bundle_ref,
          builder_source_bundle_digest,
          builder_source_bundle_binding_ref,
          builder_source_bundle_binding_digest,
          materialization_entry_count,
          materialization_total_bytes
        ) = 0 THEN TRUE
        WHEN materialization_schema_version = 'octopus.reef.materialization/v1' THEN
          CASE
            WHEN num_nonnulls(
              materialization_schema_version,
              materialization_ref,
              materialization_descriptor_digest,
              authoritative_source_bundle_digest,
              materialization_entry_count,
              materialization_total_bytes
            ) = 6
            AND num_nonnulls(
              materialization_descriptor_ref,
              builder_source_bundle_ref,
              builder_source_bundle_digest,
              builder_source_bundle_binding_ref,
              builder_source_bundle_binding_digest
            ) = 0 THEN
              (
                materialization_ref ~ '^materialization:[0-9a-f]{64}$'
                AND materialization_descriptor_digest ~ '^sha256:[0-9a-f]{64}$'
                AND authoritative_source_bundle_digest ~ '^sha256:[0-9a-f]{64}$'
                AND materialization_entry_count >= 1
                AND materialization_total_bytes >= 0
              ) IS TRUE
            ELSE FALSE
          END
        WHEN materialization_schema_version = 'octopus.reef.materialization/v2' THEN
          CASE
            WHEN num_nonnulls(
              materialization_schema_version,
              materialization_ref,
              materialization_descriptor_ref,
              materialization_descriptor_digest,
              authoritative_source_bundle_digest,
              builder_source_bundle_ref,
              builder_source_bundle_digest,
              builder_source_bundle_binding_ref,
              builder_source_bundle_binding_digest,
              materialization_entry_count,
              materialization_total_bytes
            ) = 11 THEN
              (
                materialization_ref ~ '^materialization:[0-9a-f]{64}$'
                AND materialization_descriptor_ref ~ '^materialization-descriptor:[0-9a-f]{64}$'
                AND materialization_descriptor_digest ~ '^sha256:[0-9a-f]{64}$'
                AND authoritative_source_bundle_digest = builder_source_bundle_digest
                AND builder_source_bundle_ref ~ '^source-bundle:sha256:[0-9a-f]{64}$'
                AND builder_source_bundle_digest ~ '^sha256:[0-9a-f]{64}$'
                AND builder_source_bundle_binding_ref ~ '^builder-source-bundle-binding:[0-9a-f]{64}$'
                AND builder_source_bundle_binding_digest ~ '^sha256:[0-9a-f]{64}$'
                AND materialization_entry_count >= 1
                AND materialization_total_bytes >= 0
              ) IS TRUE
            ELSE FALSE
          END
        ELSE FALSE
      END
    ) IS TRUE
  );
