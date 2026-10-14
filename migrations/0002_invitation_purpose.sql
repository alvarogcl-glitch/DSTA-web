-- D67: an invitation can also be a one-time password reset for an existing account.
ALTER TABLE invitations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'create';
