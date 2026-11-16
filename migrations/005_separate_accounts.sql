-- 005_separate_accounts.sql — a practice manager account and a therapist account are separate accounts
-- (decided 2026-11-16). One person may have both under the same email address: they sign in with one
-- emailed code, choose which account to enter, and sign out to use the other. Each account has exactly one role.

ALTER TABLE core.staff ADD COLUMN role TEXT;
UPDATE core.staff SET role = CASE WHEN is_therapist THEN 'therapist' ELSE 'practice_manager' END;
-- Anyone who held both roles keeps their existing row as the therapist account (clients point at it)
-- and gets a new, separate practice manager account.
DROP INDEX core.staff_email_uq;
INSERT INTO core.staff (name, email, is_practice_manager, is_therapist, role, status)
  SELECT name, email, true, false, 'practice_manager', status FROM core.staff WHERE is_practice_manager AND is_therapist;
ALTER TABLE core.staff DROP CONSTRAINT staff_has_a_role;
ALTER TABLE core.staff DROP COLUMN is_practice_manager, DROP COLUMN is_therapist;
ALTER TABLE core.staff ALTER COLUMN role SET NOT NULL;
ALTER TABLE core.staff ADD CONSTRAINT staff_role_ck CHECK (role IN ('practice_manager','therapist'));
CREATE UNIQUE INDEX staff_email_role_uq ON core.staff (lower(email), role);
ALTER TABLE core.staff ADD COLUMN invited_at TIMESTAMPTZ;

-- 'staff_pick': the short step between entering the code and choosing which account to enter.
ALTER TABLE core.auth_tokens DROP CONSTRAINT auth_tokens_kind_check;
ALTER TABLE core.auth_tokens ADD CONSTRAINT auth_tokens_kind_check CHECK (kind IN ('staff_code','client_link','staff_pick'));
-- Sessions opened under the old model could switch role; end them.
DELETE FROM core.sessions WHERE staff_id IS NOT NULL;
