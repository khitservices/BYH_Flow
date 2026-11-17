-- The advert or campaign an enquiry came from (utm_campaign on the link), kept with the enquiry and the client.
ALTER TABLE clinical.enquiries ADD COLUMN IF NOT EXISTS campaign TEXT;
ALTER TABLE clinical.clients   ADD COLUMN IF NOT EXISTS campaign TEXT;
