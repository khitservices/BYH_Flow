-- 006_client_invites.sql — when a client was last sent an invitation to their client area.
ALTER TABLE clinical.clients ADD COLUMN invited_at TIMESTAMPTZ;
