CREATE TABLE IF NOT EXISTS run_dispatch_outbox (
  id bigserial PRIMARY KEY,
  organisation_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  idempotency_key text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  UNIQUE (organisation_id, project_id, run_id, idempotency_key),
  FOREIGN KEY (organisation_id, project_id, run_id)
    REFERENCES agent_runs (organisation_id, project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS run_dispatch_outbox_claim_idx
  ON run_dispatch_outbox (available_at, lease_expires_at, id)
  WHERE dispatched_at IS NULL;
