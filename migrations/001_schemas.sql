-- 001_schemas.sql — the separate data areas. Tables arrive in later phases; the separation is
-- established now so permissions can be applied per schema and nothing is retrofitted.
--   engagement : enquiries, source tracking, pipeline (marketing/pre-client; no clinical detail)
--   clinical   : clients, sessions, journal, consent records
--   documents  : generated/signed document metadata (file bytes live in encrypted storage)
--   commerce   : services, price rules, vouchers, orders, payments (reserved; built later)
-- Areas link only by internal ID.
CREATE SCHEMA IF NOT EXISTS engagement;
CREATE SCHEMA IF NOT EXISTS clinical;
CREATE SCHEMA IF NOT EXISTS documents;
CREATE SCHEMA IF NOT EXISTS commerce;
