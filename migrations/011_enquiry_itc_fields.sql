-- 011_enquiry_itc_fields.sql — match the ITC contact app's enquiry record.
-- name is now always the person the therapy is FOR (the child, for a child). The parent or guardian has
-- their own fields. Before this, a child enquiry held the parent in "name" and the child in "child_name".
ALTER TABLE clinical.enquiries
  ADD COLUMN address            TEXT,
  ADD COLUMN enquiry_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN relationship       TEXT,
  ADD COLUMN guardian_name      TEXT,
  ADD COLUMN guardian_email     TEXT,
  ADD COLUMN guardian_phone     TEXT;
UPDATE clinical.enquiries
   SET guardian_name = name, guardian_email = email, guardian_phone = phone,
       name = COALESCE(NULLIF(child_name, ''), name), email = NULL, phone = NULL
 WHERE for_child;
ALTER TABLE clinical.enquiries DROP CONSTRAINT enquiry_has_contact;
ALTER TABLE clinical.enquiries DROP COLUMN child_name;
ALTER TABLE clinical.enquiries ADD CONSTRAINT enquiry_has_contact
  CHECK (email IS NOT NULL OR phone IS NOT NULL OR guardian_email IS NOT NULL OR guardian_phone IS NOT NULL);
UPDATE clinical.enquiries SET enquiry_date = created_at::date;
