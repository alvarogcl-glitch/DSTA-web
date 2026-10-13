-- Invitaciones de un solo uso: el link lleva un token aleatorio; D1 guarda solo su SHA-256.
CREATE TABLE invitations (
  token_hash TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  initial_item_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX invitations_actor_idx ON invitations(actor_id);
