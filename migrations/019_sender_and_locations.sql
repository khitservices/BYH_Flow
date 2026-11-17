-- 019_sender_and_locations.sql
-- 1) Each therapist can send client emails from their own address (same server, port and domain as the practice mailbox).
--    Optional own mailbox password, sealed with SECRETS_KEY like the practice one, never shown.
-- 2) Locations: the practice manager keeps a list (online, a therapist's home, a residency at an osteopath's, a dentist's surgery…).
--    Used for SESSIONS only. Each therapist has a usual one; a session may use another. The session keeps a copy of the name and
--    address as they were when it was booked, so later edits to a location never rewrite what a client was told.
ALTER TABLE core.staff
  ADD COLUMN sender_name         TEXT,
  ADD COLUMN sender_address      TEXT,
  ADD COLUMN sender_password_enc TEXT,
  ADD COLUMN default_location_id BIGINT;
CREATE TABLE core.locations (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'inperson' CHECK (kind IN ('inperson','online')),
  address    TEXT,
  note       TEXT,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE core.staff ADD CONSTRAINT staff_default_location_fk FOREIGN KEY (default_location_id) REFERENCES core.locations(id) ON DELETE SET NULL;
INSERT INTO core.locations (name, kind) VALUES ('Online (video call)', 'online');
ALTER TABLE clinical.appointments
  ADD COLUMN location_id      BIGINT REFERENCES core.locations(id) ON DELETE SET NULL,
  ADD COLUMN location_name    TEXT,
  ADD COLUMN location_address TEXT,
  ADD COLUMN location_note    TEXT,
  ADD COLUMN location_kind    TEXT;
