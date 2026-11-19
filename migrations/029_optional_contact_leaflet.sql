-- An enquiry no longer needs an email or phone: phone-first enquiries are often taken before contact details are known.
ALTER TABLE clinical.enquiries DROP CONSTRAINT IF EXISTS enquiry_has_contact;
INSERT INTO core.referral_sources (name) VALUES ('Leaflet/Flyer') ON CONFLICT DO NOTHING;
