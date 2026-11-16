-- 004_practice_settings.sql — the practice's name and colour, set in the app (Settings), not in .env.
CREATE TABLE core.practice_settings (
  id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  practice_name  TEXT,
  practice_short TEXT,
  color_primary  TEXT CHECK (color_primary ~ '^#[0-9a-f]{6}$'),
  updated_at     TIMESTAMPTZ,
  updated_by     INTEGER REFERENCES core.staff(id) ON DELETE SET NULL
);
INSERT INTO core.practice_settings (id) VALUES (1);
