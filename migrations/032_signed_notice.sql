-- 032_signed_notice.sql — a signed form is announced to the therapist in the app and by email, and the signer's emailed copy is retried if it fails.
-- therapist_seen_at: set when the therapist opens the signed PDF or dismisses it from "Recently signed" on their home page.
-- copy_sent_at / copy_attempts: the emailed PDF to the person who signed. Forms signed before this change count as already sent.
ALTER TABLE documents.forms ADD COLUMN therapist_seen_at TIMESTAMPTZ, ADD COLUMN copy_sent_at TIMESTAMPTZ, ADD COLUMN copy_attempts INTEGER NOT NULL DEFAULT 0;
UPDATE documents.forms SET copy_sent_at = signed_at, therapist_seen_at = signed_at WHERE status = 'signed';
ALTER TABLE core.notices ADD COLUMN ref_id BIGINT;
ALTER TABLE core.notices DROP CONSTRAINT IF EXISTS notices_kind_check;
ALTER TABLE core.notices ADD CONSTRAINT notices_kind_check CHECK (kind IN ('change','data','signed'));
