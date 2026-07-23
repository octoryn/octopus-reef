ALTER TABLE verification_runs
  ADD COLUMN IF NOT EXISTS materialization_descriptor_ref text,
  ADD COLUMN IF NOT EXISTS builder_source_bundle_ref text,
  ADD COLUMN IF NOT EXISTS builder_source_bundle_digest text,
  ADD COLUMN IF NOT EXISTS builder_source_bundle_binding_ref text,
  ADD COLUMN IF NOT EXISTS builder_source_bundle_binding_digest text;

ALTER TABLE verification_runs
  DROP CONSTRAINT IF EXISTS verification_runs_materialization_identity_check;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'verification_runs'::regclass
      AND conname = 'verification_runs_materialization_identity_check'
  ) THEN
    ALTER TABLE verification_runs
      ADD CONSTRAINT verification_runs_materialization_identity_check
      CHECK (
        (
          materialization_schema_version IS NULL
          AND materialization_ref IS NULL
          AND materialization_descriptor_ref IS NULL
          AND materialization_descriptor_digest IS NULL
          AND authoritative_source_bundle_digest IS NULL
          AND builder_source_bundle_ref IS NULL
          AND builder_source_bundle_digest IS NULL
          AND builder_source_bundle_binding_ref IS NULL
          AND builder_source_bundle_binding_digest IS NULL
          AND materialization_entry_count IS NULL
          AND materialization_total_bytes IS NULL
        )
        OR
        (
          materialization_schema_version = 'octopus.reef.materialization/v1'
          AND materialization_ref ~ '^materialization:[0-9a-f]{64}$'
          AND materialization_descriptor_ref IS NULL
          AND materialization_descriptor_digest ~ '^sha256:[0-9a-f]{64}$'
          AND authoritative_source_bundle_digest ~ '^sha256:[0-9a-f]{64}$'
          AND builder_source_bundle_ref IS NULL
          AND builder_source_bundle_digest IS NULL
          AND builder_source_bundle_binding_ref IS NULL
          AND builder_source_bundle_binding_digest IS NULL
          AND materialization_entry_count >= 1
          AND materialization_total_bytes >= 0
        )
        OR
        (
          materialization_schema_version = 'octopus.reef.materialization/v2'
          AND materialization_ref ~ '^materialization:[0-9a-f]{64}$'
          AND materialization_descriptor_ref ~ '^materialization-descriptor:[0-9a-f]{64}$'
          AND materialization_descriptor_digest ~ '^sha256:[0-9a-f]{64}$'
          AND authoritative_source_bundle_digest = builder_source_bundle_digest
          AND builder_source_bundle_ref ~ '^source-bundle:sha256:[0-9a-f]{64}$'
          AND builder_source_bundle_digest ~ '^sha256:[0-9a-f]{64}$'
          AND builder_source_bundle_binding_ref ~ '^builder-source-bundle-binding:[0-9a-f]{64}$'
          AND builder_source_bundle_binding_digest ~ '^sha256:[0-9a-f]{64}$'
          AND materialization_entry_count >= 1
          AND materialization_total_bytes >= 0
        )
      );
  END IF;
END
$migration$;
