CREATE SEQUENCE IF NOT EXISTS verification_fencing_token_seq AS bigint;

CREATE TABLE IF NOT EXISTS verification_runs (
  organisation_ref text NOT NULL,
  project_ref text NOT NULL,
  run_ref text NOT NULL,
  idempotency_key text NOT NULL,
  candidate_ref text NOT NULL,
  candidate_digest text NOT NULL,
  source_bundle_ref text NOT NULL,
  source_bundle_digest text NOT NULL,
  verification_profile_ref text NOT NULL,
  verification_profile_version text NOT NULL,
  verification_profile_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','provisioning','running','completed','failed','cancelled')),
  version bigint NOT NULL CHECK (version > 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  event_cursor bigint NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
  run_data jsonb NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organisation_ref, project_ref, run_ref),
  UNIQUE (organisation_ref, project_ref, idempotency_key)
);

CREATE INDEX IF NOT EXISTS verification_runs_state_idx
  ON verification_runs (state, updated_at);

CREATE TABLE IF NOT EXISTS verification_events (
  cursor bigserial PRIMARY KEY,
  id uuid NOT NULL,
  organisation_ref text NOT NULL,
  project_ref text NOT NULL,
  run_ref text NOT NULL,
  idempotency_key text NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (organisation_ref, project_ref, run_ref, idempotency_key),
  FOREIGN KEY (organisation_ref, project_ref, run_ref)
    REFERENCES verification_runs (organisation_ref, project_ref, run_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS verification_events_run_cursor_idx
  ON verification_events (organisation_ref, project_ref, run_ref, cursor);

CREATE TABLE IF NOT EXISTS verification_checkpoints (
  id uuid PRIMARY KEY,
  organisation_ref text NOT NULL,
  project_ref text NOT NULL,
  run_ref text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  check_ref text NOT NULL,
  result jsonb NOT NULL,
  fencing_token bigint NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (organisation_ref, project_ref, run_ref, attempt, check_ref),
  UNIQUE (organisation_ref, project_ref, run_ref, sequence),
  FOREIGN KEY (organisation_ref, project_ref, run_ref)
    REFERENCES verification_runs (organisation_ref, project_ref, run_ref) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS verification_outbox (
  id bigserial PRIMARY KEY,
  organisation_ref text NOT NULL,
  project_ref text NOT NULL,
  run_ref text NOT NULL,
  idempotency_key text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  available_at timestamptz NOT NULL,
  delivery_attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  published_at timestamptz,
  last_error text,
  UNIQUE (organisation_ref, project_ref, run_ref, idempotency_key),
  FOREIGN KEY (organisation_ref, project_ref, run_ref)
    REFERENCES verification_runs (organisation_ref, project_ref, run_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS verification_outbox_claim_idx
  ON verification_outbox (available_at, id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS verification_queue (
  id uuid PRIMARY KEY,
  organisation_ref text NOT NULL,
  project_ref text NOT NULL,
  run_ref text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  receipt uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_ref, project_ref, run_ref, attempt),
  FOREIGN KEY (organisation_ref, project_ref, run_ref)
    REFERENCES verification_runs (organisation_ref, project_ref, run_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS verification_queue_claim_idx
  ON verification_queue (available_at, created_at);
