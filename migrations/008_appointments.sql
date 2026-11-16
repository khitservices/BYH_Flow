-- 008_appointments.sql — booked sessions, carried over from the BYH app (its appointments table plus
-- migrations 007 and 019). A session is 'booked' or 'cancelled'; cancelled ones are kept for the record.
-- change_request_* is filled when a client asks to move or cancel (client area, built later).
-- ics_sequence goes up on every change so an updated calendar file replaces the earlier one.
CREATE TABLE clinical.appointments (
  id                    SERIAL PRIMARY KEY,
  client_id             INTEGER NOT NULL REFERENCES clinical.clients(id) ON DELETE CASCADE,
  starts_at             TIMESTAMPTZ NOT NULL,
  duration_min          INTEGER NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 5 AND 480),
  status                TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  change_requested_at   TIMESTAMPTZ,
  change_request_kind   TEXT CHECK (change_request_kind IN ('reschedule','cancel')),
  change_request_reason TEXT,
  cancelled_at          TIMESTAMPTZ,
  ics_sequence          INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appointments_client_idx ON clinical.appointments (client_id, starts_at);
CREATE INDEX appointments_starts_idx ON clinical.appointments (starts_at);

-- A private link the therapist can subscribe to from their own calendar app (no Microsoft Graph).
-- Only a hash of the link's secret is kept, so the link is shown once when created and can be reset.
ALTER TABLE core.staff ADD COLUMN cal_feed_hash TEXT;
CREATE UNIQUE INDEX staff_cal_feed_uq ON core.staff (cal_feed_hash) WHERE cal_feed_hash IS NOT NULL;
