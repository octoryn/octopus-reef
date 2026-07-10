CREATE TABLE billing_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  usage_record_id TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  currency TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
