-- Every automatic email (reminders, digests) is claimed here first, so a restart or a second sweep never sends it twice.
CREATE TABLE core.reminder_log (
  kind     TEXT NOT NULL,
  key      TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  sent_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);
