CREATE TABLE IF NOT EXISTS agent_runs (
  organisation_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  idempotency_key text NOT NULL,
  project_ref text NOT NULL,
  work_item_ref text,
  acceptance_ref text,
  task text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'QUEUED','PROVISIONING','PLANNING','RUNNING','WAITING_FOR_TOOL',
    'VERIFYING','WAITING_FOR_REVIEW','COMPLETED','FAILED','CANCELLED','BUDGET_EXCEEDED'
  )),
  version bigint NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  secret_refs jsonb NOT NULL DEFAULT '[]',
  budget jsonb NOT NULL DEFAULT '{}',
  usage jsonb NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  sandbox_id text,
  output text,
  failure jsonb,
  review_id text,
  PRIMARY KEY (organisation_id, project_id, id),
  UNIQUE (organisation_id, project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS agent_runs_claim_idx
  ON agent_runs (status, lease_expires_at, updated_at);

CREATE TABLE IF NOT EXISTS agent_steps (
  organisation_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  id text NOT NULL,
  ordinal integer NOT NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  attempt integer NOT NULL,
  fencing_token bigint NOT NULL,
  input jsonb,
  output jsonb,
  failure jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (organisation_id, project_id, run_id, id),
  UNIQUE (organisation_id, project_id, run_id, idempotency_key),
  UNIQUE (organisation_id, project_id, run_id, ordinal),
  FOREIGN KEY (organisation_id, project_id, run_id)
    REFERENCES agent_runs (organisation_id, project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_checkpoints (
  organisation_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  id text NOT NULL,
  idempotency_key text NOT NULL,
  sequence integer NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  step jsonb,
  usage jsonb,
  checksum text NOT NULL,
  fencing_token bigint NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organisation_id, project_id, run_id, id),
  UNIQUE (organisation_id, project_id, run_id, idempotency_key),
  UNIQUE (organisation_id, project_id, run_id, sequence),
  FOREIGN KEY (organisation_id, project_id, run_id)
    REFERENCES agent_runs (organisation_id, project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_events (
  cursor bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  organisation_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  idempotency_key text,
  type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (organisation_id, project_id, run_id, idempotency_key),
  FOREIGN KEY (organisation_id, project_id, run_id)
    REFERENCES agent_runs (organisation_id, project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS run_events_stream_idx
  ON run_events (organisation_id, project_id, run_id, cursor);

CREATE TABLE IF NOT EXISTS run_outbox (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE REFERENCES run_events(id) ON DELETE CASCADE,
  organisation_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS run_outbox_publish_idx
  ON run_outbox (published_at, lease_expires_at, id);

CREATE TABLE IF NOT EXISTS run_queue (
  organisation_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  id text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  receipt text,
  PRIMARY KEY (organisation_id, project_id, run_id),
  FOREIGN KEY (organisation_id, project_id, run_id)
    REFERENCES agent_runs (organisation_id, project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS run_queue_claim_idx
  ON run_queue (available_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS run_reviews (
  organisation_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  run_id text NOT NULL,
  reason text NOT NULL,
  context jsonb,
  created_at timestamptz NOT NULL,
  decision text CHECK (decision IN ('APPROVED','REJECTED')),
  actor_ref text,
  decision_reason text,
  decided_at timestamptz,
  PRIMARY KEY (organisation_id, project_id, id),
  FOREIGN KEY (organisation_id, project_id, run_id)
    REFERENCES agent_runs (organisation_id, project_id, id) ON DELETE CASCADE
);
