-- 002_identity.sql — staff, clients (login identity only for now), sign-in tokens, sessions, audit log.
--
-- Access model (decided 2026-11-13):
--   * practice_manager: sees enquiries, bookings, sources, schedules. NEVER clinical content.
--   * therapist:        the only role that sees clinical data (clients, journals, notes).
--   * one staff member may hold both roles (e.g. a solo practitioner) but acts in one role at a time.
--   * client:           sees only their own record.
-- Secrets (session ids, codes, link tokens) are stored as HMAC hashes, never in clear.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE core.staff (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  email              TEXT NOT NULL,
  is_practice_manager BOOLEAN NOT NULL DEFAULT false,
  is_therapist       BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_has_a_role CHECK (is_practice_manager OR is_therapist)
);
CREATE UNIQUE INDEX staff_email_uq ON core.staff (lower(email));

-- Clinical identity only at this stage; later phases add the rest of the client record.
CREATE TABLE clinical.clients (
  id           SERIAL PRIMARY KEY,
  therapist_id INTEGER NOT NULL REFERENCES core.staff(id),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','readonly','closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX clients_email_uq ON clinical.clients (lower(email));
CREATE INDEX clients_therapist_idx ON clinical.clients (therapist_id);

-- Staff: 6-digit emailed code. Clients: emailed link (+ poll key so an installed phone app can finish).
CREATE TABLE core.auth_tokens (
  id              SERIAL PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('staff_code','client_link')),
  staff_id        INTEGER REFERENCES core.staff(id) ON DELETE CASCADE,
  client_id       INTEGER REFERENCES clinical.clients(id) ON DELETE CASCADE,
  secret_hash     TEXT NOT NULL,
  poll_hash       TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  poll_claimed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_secret_idx ON core.auth_tokens (secret_hash);
CREATE INDEX auth_tokens_poll_idx ON core.auth_tokens (poll_hash);

CREATE TABLE core.sessions (
  id_hash     TEXT PRIMARY KEY,
  staff_id    INTEGER REFERENCES core.staff(id) ON DELETE CASCADE,
  client_id   INTEGER REFERENCES clinical.clients(id) ON DELETE CASCADE,
  active_role TEXT CHECK (active_role IN ('practice_manager','therapist','client')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  CONSTRAINT session_one_principal CHECK ((staff_id IS NOT NULL) <> (client_id IS NOT NULL))
);

-- Who did what to which record. Never stores codes, tokens or clinical content.
CREATE TABLE core.audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type   TEXT,
  actor_id     INTEGER,
  action       TEXT NOT NULL,
  subject_type TEXT,
  subject_id   INTEGER,
  detail       JSONB,
  ip           TEXT
);
CREATE INDEX audit_log_at_idx ON core.audit_log (at);
