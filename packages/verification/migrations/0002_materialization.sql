ALTER TABLE verification_runs
  ADD COLUMN IF NOT EXISTS materialization_schema_version text,
  ADD COLUMN IF NOT EXISTS materialization_ref text,
  ADD COLUMN IF NOT EXISTS materialization_descriptor_digest text,
  ADD COLUMN IF NOT EXISTS authoritative_source_bundle_digest text,
  ADD COLUMN IF NOT EXISTS materialization_entry_count bigint,
  ADD COLUMN IF NOT EXISTS materialization_total_bytes bigint;

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
          AND materialization_descriptor_digest IS NULL
          AND authoritative_source_bundle_digest IS NULL
          AND materialization_entry_count IS NULL
          AND materialization_total_bytes IS NULL
        )
        OR
        (
          materialization_schema_version = 'octopus.reef.materialization/v1'
          AND materialization_ref ~ '^materialization:[0-9a-f]{64}$'
          AND materialization_descriptor_digest ~ '^sha256:[0-9a-f]{64}$'
          AND authoritative_source_bundle_digest ~ '^sha256:[0-9a-f]{64}$'
          AND materialization_entry_count >= 1
          AND materialization_total_bytes >= 0
        )
      );
  END IF;
END
$migration$;
