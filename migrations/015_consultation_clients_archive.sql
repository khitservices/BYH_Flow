-- 015_consultation_clients_archive.sql — the person stops being an enquiry once a consultation is booked, and records
-- that do not go ahead are ARCHIVED, not lost (Kev).
-- A client now starts life at 'consultation' (initial consultation booked, or to be booked after a returning contact),
-- moves to 'attended', and becomes 'active' only when they proceed and a programme is chosen. So a client may
-- legitimately have no programme and (for a child) no consent recorded yet. Neither is allowed once they are active.
-- Archive: an enquiry that goes nowhere (archived by hand, or untouched for 60 days) and a client who did not proceed are
-- kept, out of the working lists. If the same person gets in touch again the therapist is shown the match and can restore it.
ALTER TABLE clinical.clients DROP CONSTRAINT clients_status_check;
ALTER TABLE clinical.clients ADD CONSTRAINT clients_status_check CHECK (status IN ('consultation','attended','active','readonly','closed'));
ALTER TABLE clinical.clients ALTER COLUMN programme_sessions DROP NOT NULL;
ALTER TABLE clinical.clients DROP CONSTRAINT clients_consent_status_check;
ALTER TABLE clinical.clients ADD CONSTRAINT clients_consent_status_check CHECK (consent_status IN ('n/a','pending','granted'));
ALTER TABLE clinical.clients
  ADD COLUMN ic_at          TIMESTAMPTZ,            -- initial consultation; null = not yet booked
  ADD COLUMN ic_sequence    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN channel        TEXT CHECK (channel IN ('website','therapist_page','google','facebook','phone')),
  ADD COLUMN address        TEXT,
  ADD COLUMN enquiry_date   DATE,
  ADD COLUMN closed_reason  TEXT CHECK (closed_reason IN ('completed','did_not_proceed')),
  ADD COLUMN archived_at    TIMESTAMPTZ;
ALTER TABLE clinical.clients DROP CONSTRAINT under16_needs_consent;
ALTER TABLE clinical.clients ADD CONSTRAINT under16_needs_consent
  CHECK (NOT under16 OR consent_status = 'granted' OR status IN ('consultation','attended') OR COALESCE(closed_reason,'') = 'did_not_proceed');
ALTER TABLE clinical.clients ADD CONSTRAINT programme_when_active
  CHECK (programme_sessions IS NOT NULL OR status IN ('consultation','attended') OR COALESCE(closed_reason,'') = 'did_not_proceed');
CREATE INDEX clients_archived_idx ON clinical.clients (therapist_id) WHERE archived_at IS NOT NULL;

ALTER TABLE clinical.enquiries
  ADD COLUMN archived_at      TIMESTAMPTZ,
  ADD COLUMN archive_reason   TEXT CHECK (archive_reason IN ('manual','stale')),
  ADD COLUMN last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX enquiries_archived_idx ON clinical.enquiries (therapist_id) WHERE archived_at IS NOT NULL;

-- Anyone already past the booking stage becomes a client. (Only possible while testing: nothing live yet.)
INSERT INTO clinical.clients (therapist_id, name, email, phone, under16, guardian_name, guardian_email, guardian_phone, consent_status,
    status, ic_at, ic_sequence, channel, address, enquiry_date, programme_sessions)
SELECT e.therapist_id, e.name, COALESCE(e.email, e.guardian_email), e.phone, e.for_child, e.guardian_name, e.guardian_email, e.guardian_phone,
       CASE WHEN e.for_child THEN 'pending' ELSE 'n/a' END, CASE e.stage WHEN 'consultation' THEN 'consultation' ELSE 'attended' END,
       e.ic_at, e.ic_sequence, e.channel, e.address, e.enquiry_date, NULL
  FROM clinical.enquiries e
 WHERE e.stage IN ('consultation','attended','proceeding') AND COALESCE(e.email, e.guardian_email) IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM clinical.clients c WHERE lower(c.email) = lower(COALESCE(e.email, e.guardian_email)));
UPDATE clinical.enquiries e SET stage = 'converted',
       converted_client_id = (SELECT c.id FROM clinical.clients c WHERE lower(c.email) = lower(COALESCE(e.email, e.guardian_email)) LIMIT 1)
 WHERE e.stage IN ('consultation','attended','proceeding') AND COALESCE(e.email, e.guardian_email) IS NOT NULL
   AND EXISTS (SELECT 1 FROM clinical.clients c WHERE lower(c.email) = lower(COALESCE(e.email, e.guardian_email)));
UPDATE documents.forms f SET client_id = e.converted_client_id FROM clinical.enquiries e
 WHERE f.enquiry_id = e.id AND f.client_id IS NULL AND e.converted_client_id IS NOT NULL;
UPDATE clinical.enquiries SET stage = 'new' WHERE stage IN ('consultation','attended','proceeding');    -- no email to invite: back to an enquiry
UPDATE clinical.enquiries SET stage = 'new', archived_at = now(), archive_reason = 'manual' WHERE stage = 'not_proceeding';
