-- 003_mail_settings.sql — the practice's outgoing mailbox, configured in the app (Settings), not in .env.
-- One row. Every email the app sends (sign-in codes and links now; reminders, consent requests later)
-- goes through this mailbox over SMTP. The password is sealed with SECRETS_KEY and never stored in clear.

CREATE TABLE core.mail_settings (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  smtp_host         TEXT,
  smtp_port         INTEGER CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_secure       BOOLEAN NOT NULL DEFAULT false,   -- true: TLS from the start (465); false: STARTTLS (587)
  smtp_user         TEXT,
  smtp_password_enc TEXT,
  from_name         TEXT,
  from_address      TEXT,
  updated_at        TIMESTAMPTZ,
  updated_by        INTEGER REFERENCES core.staff(id) ON DELETE SET NULL
);
INSERT INTO core.mail_settings (id) VALUES (1);
