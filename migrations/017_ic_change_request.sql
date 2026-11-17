-- 017_ic_change_request.sql — a client can ask to move or cancel their initial consultation (sessions already had this on appointments).
ALTER TABLE clinical.clients
  ADD COLUMN ic_change_requested_at TIMESTAMPTZ,
  ADD COLUMN ic_change_kind   TEXT CHECK (ic_change_kind IN ('reschedule','cancel')),
  ADD COLUMN ic_change_reason TEXT;
