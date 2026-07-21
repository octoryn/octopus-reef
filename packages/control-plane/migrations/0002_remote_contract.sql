ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS baseline_revision_ref text;

UPDATE agent_runs
SET baseline_revision_ref = 'legacy:unspecified'
WHERE baseline_revision_ref IS NULL;

ALTER TABLE agent_runs
  ALTER COLUMN baseline_revision_ref SET NOT NULL;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS result_refs jsonb NOT NULL
  DEFAULT '{"evidenceRefs":[]}'::jsonb;
