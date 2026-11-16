-- 009_therapist_account.sql — therapist's own settings, carried over from BYH (its migrations 009 and 010).
-- relax_url: a guided-relaxation link the therapist chooses, shown to their clients in the client area.
-- close_requested_at: the therapist has asked for their account to be closed; a practice manager acts on it.
ALTER TABLE core.staff ADD COLUMN relax_url TEXT, ADD COLUMN close_requested_at TIMESTAMPTZ;
