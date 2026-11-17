-- The practice's own list of "how did you hear about us" answers (from Kev, 17 Nov 2026), and who referred them.
ALTER TABLE clinical.enquiries ADD COLUMN IF NOT EXISTS referrer_name TEXT;
ALTER TABLE clinical.clients   ADD COLUMN IF NOT EXISTS referrer_name TEXT;
-- Renames keep the records that already use them.
UPDATE core.referral_sources SET name='Google ads' WHERE name='Google' AND NOT EXISTS (SELECT 1 FROM core.referral_sources WHERE name='Google ads');
UPDATE clinical.enquiries SET heard_from='Google ads' WHERE heard_from='Google';
UPDATE clinical.clients   SET heard_from='Google ads' WHERE heard_from='Google';
UPDATE core.referral_sources SET name='Referral' WHERE name='Word of mouth' AND NOT EXISTS (SELECT 1 FROM core.referral_sources WHERE name='Referral');
UPDATE clinical.enquiries SET heard_from='Referral' WHERE heard_from='Word of mouth';
UPDATE clinical.clients   SET heard_from='Referral' WHERE heard_from='Word of mouth';
UPDATE core.referral_sources SET active=false WHERE name='Recommended by another professional';   -- not in the practice's list; records keep it
INSERT INTO core.referral_sources (name) VALUES ('Facebook'), ('Instagram'), ('Google ads'), ('Referral'), ('Hypnotherapy directory'), ('Browser search'), ('Event referral'), ('Previous client'), ('LinkedIn'), ('Website') ON CONFLICT DO NOTHING;
