-- 020_weekly_scores.sql — the client's weekly "how I feel" score, 1 to 10. Standalone (not tied to a journal entry),
-- at most one per client per week (weeks start on Monday, UK time); a week with no entry is simply absent, shown as a gap.
-- Seen by the client and their own therapist only. The practice manager never sees values (counts of entries at most).
CREATE TABLE clinical.weekly_scores (
  id         BIGSERIAL PRIMARY KEY,
  client_id  BIGINT NOT NULL REFERENCES clinical.clients(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, week_start)
);
