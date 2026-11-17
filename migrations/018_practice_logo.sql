-- 018_practice_logo.sql — the practice's logo, uploaded in the app (Settings > Practice details).
-- Held in the database (small, and public by design: it appears on the sign-in pages and in emails). PNG, JPEG or WebP only.
ALTER TABLE core.practice_settings
  ADD COLUMN logo         BYTEA,
  ADD COLUMN logo_type    TEXT CHECK (logo_type IN ('image/png','image/jpeg','image/webp')),
  ADD COLUMN logo_version INTEGER NOT NULL DEFAULT 0;
