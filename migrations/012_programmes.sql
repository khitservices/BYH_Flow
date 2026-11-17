-- 012_programmes.sql — named programmes the practice offers: a number of sessions and an optional price.
-- A single fixed-price session (smoking cessation, say) is simply a programme of 1 session.
-- The practice manager keeps the list. A client keeps a COPY of the programme's name, sessions and price from
-- when it was chosen, so changing or retiring a programme later never changes an existing client's record.
-- Programmes are retired, not deleted, because clients refer to them. Prices are recorded only: no payments here.
CREATE TABLE core.programmes (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  sessions    INTEGER NOT NULL CHECK (sessions BETWEEN 1 AND 60),
  price_pence INTEGER CHECK (price_pence IS NULL OR price_pence >= 0),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The lengths the app has offered until now, so nothing changes for existing use. No prices are invented.
INSERT INTO core.programmes (name, sessions) VALUES ('6-session programme', 6), ('8-session programme', 8), ('10-session programme', 10), ('12-session programme', 12);

ALTER TABLE clinical.clients
  ADD COLUMN programme_id          INTEGER REFERENCES core.programmes(id),
  ADD COLUMN programme_name        TEXT,
  ADD COLUMN programme_price_pence INTEGER;
UPDATE clinical.clients SET programme_name = programme_sessions || '-session programme';
