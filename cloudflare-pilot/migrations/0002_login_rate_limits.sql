CREATE TABLE login_limits (
  ip_hash TEXT PRIMARY KEY NOT NULL,
  minute_bucket INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1)
);
CREATE INDEX login_limits_bucket_idx ON login_limits(minute_bucket);
