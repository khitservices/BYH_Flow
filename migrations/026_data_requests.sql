-- A client's request about their own information: a copy of it, or its deletion. Recorded for their therapist to answer.
CREATE TABLE clinical.data_requests (
  id           BIGSERIAL PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clinical.clients(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('copy','delete')),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at   TIMESTAMPTZ,
  handled_note TEXT
);
CREATE INDEX data_requests_open_idx ON clinical.data_requests (client_id) WHERE handled_at IS NULL;
