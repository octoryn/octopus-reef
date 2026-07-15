export const MIGRATIONS: readonly {
  readonly id: string;
  readonly sql: string;
}[] = [
  {
    id: "0001_control_plane",
    sql: `
CREATE TABLE IF NOT EXISTS gateway_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_ledger (
  sequence INTEGER PRIMARY KEY,
  evidence_json TEXT NOT NULL,
  link_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  team_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  entitlements_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS quotas (
  account_id TEXT PRIMARY KEY,
  limit_tokens INTEGER NOT NULL,
  used_tokens INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  evidence_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(team_id, account_id)
);
`,
  },
  {
    id: "0002_billing_ledger",
    sql: `
CREATE TABLE IF NOT EXISTS billing_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  usage_record_id TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  currency TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
];
