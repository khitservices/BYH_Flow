-- 007_client_record.sql — the client record, carried over from the BYH app as one clean step
-- (its migrations 001, 003, 005, 011, 017 and 018 combined).
--
-- Progress is counted in SESSIONS, not weeks: a client who misses a week is on their next session.
-- sessions_before_app is for someone who joins part-way through (already had 3 of 8, say).
-- programme_number goes up when a client returns for a fresh programme, so the earlier one is kept apart.
-- Under-16s: consent is obtained in person and attested by the therapist here; the record cannot be
-- created without it. The young person then signs in with their own email like any client.
ALTER TABLE clinical.clients
  ADD COLUMN phone                TEXT,
  ADD COLUMN under16              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN guardian_name        TEXT,
  ADD COLUMN guardian_email       TEXT,
  ADD COLUMN guardian_phone       TEXT,
  ADD COLUMN consent_status       TEXT NOT NULL DEFAULT 'n/a' CHECK (consent_status IN ('n/a','granted')),
  ADD COLUMN consent_at           TIMESTAMPTZ,
  ADD COLUMN consent_method       TEXT,
  ADD COLUMN consent_note         TEXT,
  ADD COLUMN consent_recorded_by  INTEGER REFERENCES core.staff(id) ON DELETE SET NULL,
  ADD COLUMN programme_sessions   INTEGER NOT NULL DEFAULT 8 CHECK (programme_sessions BETWEEN 1 AND 60),
  ADD COLUMN sessions_before_app  INTEGER NOT NULL DEFAULT 0 CHECK (sessions_before_app >= 0),
  ADD COLUMN programme_number     INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN programme_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN reminders_on         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN reminder_dow         INTEGER NOT NULL DEFAULT 3 CHECK (reminder_dow BETWEEN 0 AND 6),  -- 0=Sun..6=Sat
  ADD COLUMN last_reminded_at     TIMESTAMPTZ,
  ADD COLUMN closed_at            TIMESTAMPTZ;
ALTER TABLE clinical.clients ADD CONSTRAINT under16_needs_consent CHECK (NOT under16 OR consent_status = 'granted');
