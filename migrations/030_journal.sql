-- 030_journal.sql — the client's private journal: written entries, each with at most one attached file (photo, PDF, document).
-- PRIVATE TO THE CLIENT. Nobody else can read an entry or open a file: not their therapist, not the practice manager.
-- The therapist is shown counts only (how many entries, and when), never the content (see lib/journal.js).
-- block_id records which block of sessions the entry was written in, so earlier blocks can be looked back on read-only.
-- An entry can be edited for 15 minutes after posting; saving an edit locks it for good.
-- Files are held encrypted in the document store (lib/storage.js); object_id is the store's random id.
CREATE TABLE clinical.journal_entries (
  id         BIGSERIAL PRIMARY KEY,
  client_id  BIGINT NOT NULL REFERENCES clinical.clients(id) ON DELETE CASCADE,
  block_id   BIGINT REFERENCES clinical.programme_blocks(id),
  body       TEXT NOT NULL DEFAULT '',
  file_object_id TEXT,
  file_name  TEXT,
  file_mime  TEXT,
  file_bytes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at  TIMESTAMPTZ,
  locked     BOOLEAN NOT NULL DEFAULT false,
  CHECK (body <> '' OR file_object_id IS NOT NULL)
);
CREATE INDEX journal_entries_client_idx ON clinical.journal_entries (client_id, created_at);
