-- Cuentas multiusuario (AUTH_MODE=accounts). Solo salt+hash de contraseñas y hashes de tokens.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- Durable Object del usuario; NULL = "u:<id>". F6 mapea al CEO a "pmo-dsta" sin migrar datos.
  do_name TEXT,
  disabled_at INTEGER
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_actor_idx ON sessions(actor_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE login_limits (
  ip_hash TEXT PRIMARY KEY NOT NULL,
  minute_bucket INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

CREATE TABLE invitations (
  token_hash TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX invitations_actor_idx ON invitations(actor_id);
