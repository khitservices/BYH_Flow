-- 010_enquiries.sql — the enquiry pipeline (BYH's enquiries plus the first stages of the ITC contact app).
-- Every enquiry belongs to ONE therapist from the moment it arrives. The practice manager never sees
-- these rows, only counts (by route and stage). Agreements and documents come in the next step.
-- channel = how it arrived: website, therapist_page, google, facebook, phone (typed in by the therapist).
-- stage: new → consultation (a date is set) → proceeding / not_proceeding → converted (became a client).
-- No reason-for-enquiring field: that would be health information; the therapist asks in conversation.
CREATE TABLE clinical.enquiries (
  id                  SERIAL PRIMARY KEY,
  therapist_id        INTEGER NOT NULL REFERENCES core.staff(id),
  channel             TEXT NOT NULL CHECK (channel IN ('website','therapist_page','google','facebook','phone')),
  for_child           BOOLEAN NOT NULL DEFAULT false,
  name                TEXT NOT NULL,           -- the person enquiring (the parent or guardian if for a child)
  child_name          TEXT,
  email               TEXT,
  phone               TEXT,
  notes               TEXT,
  stage               TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','consultation','proceeding','not_proceeding','converted')),
  ic_at               TIMESTAMPTZ,             -- initial consultation date and time
  ic_sequence         INTEGER NOT NULL DEFAULT 0,
  converted_client_id INTEGER REFERENCES clinical.clients(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enquiry_has_contact CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX enquiries_therapist_idx ON clinical.enquiries (therapist_id, stage);

-- Each therapist's own link for their private enquiry page. Not a secret, just not guessable by counting.
ALTER TABLE core.staff ADD COLUMN enquiry_slug TEXT;
CREATE UNIQUE INDEX staff_enquiry_slug_uq ON core.staff (enquiry_slug) WHERE enquiry_slug IS NOT NULL;
UPDATE core.staff SET enquiry_slug = substr(md5(random()::text || id::text || clock_timestamp()::text), 1, 12) WHERE role = 'therapist';
