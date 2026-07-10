CREATE TABLE gateway_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE gateway_ledger (
  sequence INTEGER PRIMARY KEY,
  evidence_json TEXT NOT NULL,
  link_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  team_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  entitlements_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE TABLE quotas (
  account_id TEXT PRIMARY KEY,
  limit_tokens INTEGER NOT NULL,
  used_tokens INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  evidence_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(team_id, account_id),
  FOREIGN KEY(team_id) REFERENCES teams(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
