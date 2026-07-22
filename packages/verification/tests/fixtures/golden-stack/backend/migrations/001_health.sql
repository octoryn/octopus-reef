CREATE TABLE IF NOT EXISTS verification_health (
  id integer PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('ready'))
);

INSERT INTO verification_health (id, status)
VALUES (1, 'ready')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;
