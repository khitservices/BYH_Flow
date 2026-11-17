-- 013_forms.sql — digital forms: templates, sent/signed copies, and the therapist's own details for merging.
-- core.form_templates: the practice's forms as DATA (sections, which signer details to ask for, consent choices),
--   so another practice or a standalone practitioner can have different wording. The ITC set is seeded in 014.
-- documents.forms: one row per form SENT to a person. It keeps the exact text shown (rendered) and a SHA-256 of it,
--   so changing a template later never alters what someone signed. The signed PDF lives in encrypted storage.
-- A form belongs to the enquiry it was sent from and, once that person becomes a client, to the client folder.
CREATE TABLE core.form_templates (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  audience   TEXT NOT NULL CHECK (audience IN ('adult','child')),   -- child: signed by the parent or guardian
  body       JSONB NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE documents.forms (
  id             SERIAL PRIMARY KEY,
  therapist_id   INTEGER NOT NULL REFERENCES core.staff(id),
  enquiry_id     INTEGER REFERENCES clinical.enquiries(id) ON DELETE SET NULL,
  client_id      INTEGER REFERENCES clinical.clients(id) ON DELETE SET NULL,
  template_id    INTEGER REFERENCES core.form_templates(id),
  template_name  TEXT NOT NULL,
  audience       TEXT NOT NULL CHECK (audience IN ('adult','child')),
  rendered       JSONB NOT NULL,                 -- the exact text and choices shown to the signer
  content_sha256 TEXT NOT NULL,
  sent_to        TEXT,
  token_hash     TEXT,
  token_expires_at TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','signed','void')),
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_at      TIMESTAMPTZ,
  signer         JSONB,                          -- name, relationship, address, phone, choices
  signer_ip      TEXT,
  signer_agent   TEXT,
  file_id        TEXT,                           -- encrypted signed PDF in storage
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT form_owner CHECK (enquiry_id IS NOT NULL OR client_id IS NOT NULL OR status = 'void')
);
CREATE INDEX forms_token_idx ON documents.forms (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX forms_therapist_idx ON documents.forms (therapist_id, status);

-- Therapist details that go into a form (ITC's "My details").
ALTER TABLE core.staff
  ADD COLUMN qualifications  TEXT,
  ADD COLUMN address         TEXT,
  ADD COLUMN postcode        TEXT,
  ADD COLUMN phone           TEXT,
  ADD COLUMN default_fee_pence INTEGER CHECK (default_fee_pence IS NULL OR default_fee_pence >= 0);

-- Enquiry stage 'attended': the consultation has happened and forms can go out.
ALTER TABLE clinical.enquiries DROP CONSTRAINT enquiries_stage_check;
ALTER TABLE clinical.enquiries ADD CONSTRAINT enquiries_stage_check CHECK (stage IN ('new','consultation','attended','proceeding','not_proceeding','converted'));
