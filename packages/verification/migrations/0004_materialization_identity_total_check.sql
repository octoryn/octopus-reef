DO $migration$
DECLARE
  identity_predicate CONSTANT text := $predicate$
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
  $predicate$;
  invalid_row_count bigint;
BEGIN
  EXECUTE 'LOCK TABLE verification_runs IN ACCESS EXCLUSIVE MODE';
  EXECUTE format(
    'SELECT count(*) FROM verification_runs WHERE NOT (%s)',
    identity_predicate
  ) INTO invalid_row_count;

  IF invalid_row_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        '0004_materialization_identity_total_check aborted: %s row(s) have a partial or invalid materialization identity',
        invalid_row_count
      ),
      DETAIL = 'No verification_runs rows were modified; the prior constraint remains in place.',
      HINT = 'Keep API and Worker stopped. Use an explicitly reviewed recovery procedure, then retry this exact migration.';
  END IF;

  EXECUTE
    'ALTER TABLE verification_runs DROP CONSTRAINT IF EXISTS verification_runs_materialization_identity_check';
  EXECUTE format(
    'ALTER TABLE verification_runs ADD CONSTRAINT verification_runs_materialization_identity_check CHECK (%s)',
    identity_predicate
  );
END
$migration$;
