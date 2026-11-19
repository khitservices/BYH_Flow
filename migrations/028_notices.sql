-- Emails telling a therapist a client has asked for something (change request, request about their information).
-- Recorded first and sent after, so a failed send is retried in the background.
CREATE TABLE core.notices (
  id         BIGSERIAL PRIMARY KEY,
  therapist_id INTEGER NOT NULL REFERENCES core.staff(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('change','data')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TIMESTAMPTZ
);
CREATE INDEX notices_unsent_idx ON core.notices (id) WHERE sent_at IS NULL;
