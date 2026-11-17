-- An optional note the client can add to their weekly score, for their own therapist to read.
ALTER TABLE clinical.weekly_scores ADD COLUMN IF NOT EXISTS note TEXT;
