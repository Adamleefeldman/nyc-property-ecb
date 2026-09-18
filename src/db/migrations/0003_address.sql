-- Address input. A property whose address could not be geocoded yet has no
-- lot, so bbl and its parts become nullable; the unique constraint on bbl
-- still holds for the rows that have one.
ALTER TABLE properties
  ALTER COLUMN bbl DROP NOT NULL,
  ALTER COLUMN borough DROP NOT NULL,
  ALTER COLUMN block DROP NOT NULL,
  ALTER COLUMN lot DROP NOT NULL,
  ADD COLUMN pluto jsonb;                      -- parcel facts from PLUTO, as returned

-- The apartment / suite token, kept so the same unit maps to the same building.
ALTER TABLE property_inputs ADD COLUMN unit text;
