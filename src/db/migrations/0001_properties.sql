-- A property is a lot, identified by its canonical 10-digit BBL.
CREATE TABLE properties (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bbl                char(10) NOT NULL UNIQUE,
  borough            smallint NOT NULL CHECK (borough BETWEEN 1 AND 5),
  block              char(5) NOT NULL,
  lot                char(4) NOT NULL,
  normalized_address text,
  resolution_status  text NOT NULL CHECK (resolution_status IN ('resolved', 'unresolved', 'pending', 'not_applicable')),
  resolution_source  text,
  resolved_at        timestamptz,
  resolution_reason  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Every input we were ever given, and which property it landed on.
-- input_key is what makes two inputs "the same" (per kind); raw_input is
-- exactly what the caller sent, kept for the audit trail.
CREATE TABLE property_inputs (
  kind        text NOT NULL CHECK (kind IN ('bbl', 'address')),
  input_key   text NOT NULL,
  raw_input   text NOT NULL,
  property_id uuid NOT NULL REFERENCES properties (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, input_key)
);
CREATE INDEX property_inputs_property_id_idx ON property_inputs (property_id);

-- Buildings on the lot. One lot can carry several BINs. Filled by the resolver.
CREATE TABLE property_bins (
  property_id    uuid NOT NULL REFERENCES properties (id) ON DELETE CASCADE,
  bin            text NOT NULL,
  is_placeholder boolean NOT NULL DEFAULT false,
  source         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, bin)
);
