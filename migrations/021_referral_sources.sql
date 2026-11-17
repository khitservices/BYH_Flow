-- "How did you hear about us": a list the practice manager keeps and therapists can add to on the spot.
CREATE TABLE IF NOT EXISTS core.referral_sources (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS referral_sources_name_ci ON core.referral_sources (lower(name));
INSERT INTO core.referral_sources (name) VALUES ('Website'), ('Google'), ('Facebook'), ('Word of mouth'), ('Recommended by another professional') ON CONFLICT DO NOTHING;
ALTER TABLE clinical.enquiries ADD COLUMN IF NOT EXISTS heard_from TEXT;
ALTER TABLE clinical.clients   ADD COLUMN IF NOT EXISTS heard_from TEXT;
