-- 031_retention.sql — keeping and deleting client records in line with clinical record-keeping guidance.
-- date_of_birth: optional, used only to work out how long a child's record must be kept (under-18s).
-- retention_hold: the therapist can stop automatic deletion while a complaint or legal matter is possible; the note says why.
ALTER TABLE clinical.clients
  ADD COLUMN date_of_birth DATE,
  ADD COLUMN retention_hold BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN retention_hold_note TEXT;
