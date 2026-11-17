-- Whether the therapist has been emailed about a new website enquiry, so a failed send is retried in the background.
ALTER TABLE clinical.enquiries ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS notify_attempts INTEGER NOT NULL DEFAULT 0;
UPDATE clinical.enquiries SET notified_at = created_at WHERE notified_at IS NULL;   -- everything before this is treated as already handled
