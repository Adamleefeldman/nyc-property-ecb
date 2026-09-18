-- One row per pipeline run: the run log the assignment asks for.
CREATE TABLE ingestion_runs (
  id                     bigserial PRIMARY KEY,
  dataset                text NOT NULL DEFAULT 'ecb',
  trigger                text NOT NULL,            -- cli | scheduler | api
  status                 text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  started_at             timestamptz NOT NULL DEFAULT now(),
  finished_at            timestamptz,
  source_rows_updated_at timestamptz,              -- the dataset's own rowsUpdatedAt at run start
  socrata_calls          integer NOT NULL DEFAULT 0,
  rows_fetched           integer NOT NULL DEFAULT 0,
  rows_stored            integer NOT NULL DEFAULT 0,
  rows_new               integer NOT NULL DEFAULT 0,
  rows_changed           integer NOT NULL DEFAULT 0,
  properties_checked     integer NOT NULL DEFAULT 0,
  batches_failed         integer NOT NULL DEFAULT 0,
  error                  text
);

-- The city's row, untouched. Keyed on the violation number, which is unique
-- across the dataset. Socrata's own :id changes on every refresh, so it is
-- stored for provenance but never used as a key.
CREATE TABLE ecb_violations_raw (
  ecb_violation_number text PRIMARY KEY,
  socrata_id           text NOT NULL,
  socrata_created_at   timestamptz,
  socrata_updated_at   timestamptz,
  payload              jsonb NOT NULL,
  fetched_at           timestamptz NOT NULL DEFAULT now(),
  run_id               bigint NOT NULL REFERENCES ingestion_runs (id)
);

-- Our typed copy, rebuilt from raw by `npm run renormalize` with no network.
CREATE TABLE ecb_violations (
  ecb_violation_number    text PRIMARY KEY REFERENCES ecb_violations_raw (ecb_violation_number) ON DELETE CASCADE,
  bin                     text,
  bbl                     char(10),
  borough                 smallint,
  block                   char(5),
  lot                     char(4),
  status                  text,                     -- ecb_violation_status: ACTIVE | RESOLVE
  issue_date              date,
  served_date             date,
  hearing_date            date,
  hearing_status          text,
  certification_status    text,
  severity                text,
  violation_type          text,
  violation_description   text,
  respondent_name         text,
  penalty_imposed         numeric(14, 2),
  amount_paid             numeric(14, 2),
  balance_due             numeric(14, 2),
  dob_violation_number    text,
  infraction_code         text,
  section_law_description text,
  aggravated_level        text,
  content_hash            text NOT NULL,            -- of the normalized values; drives updated_at
  first_seen_run_id       bigint NOT NULL REFERENCES ingestion_runs (id),
  last_seen_run_id        bigint NOT NULL REFERENCES ingestion_runs (id),
  stored_at               timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()  -- our clock: when the served values last changed
);
CREATE INDEX ecb_violations_bin_issue_idx ON ecb_violations (bin, issue_date DESC, ecb_violation_number);
CREATE INDEX ecb_violations_updated_idx ON ecb_violations (updated_at, ecb_violation_number);
CREATE INDEX ecb_violations_unpaid_idx ON ecb_violations (bin) WHERE balance_due > 0;

-- Per property: did we check it, when, and what did we find. The API reads
-- this to say "checked, none" versus "not checked yet".
CREATE TABLE property_coverage (
  property_id            uuid NOT NULL REFERENCES properties (id) ON DELETE CASCADE,
  dataset                text NOT NULL DEFAULT 'ecb',
  state                  text NOT NULL CHECK (state IN ('checked', 'failed')),
  checked_at             timestamptz,
  run_id                 bigint REFERENCES ingestion_runs (id),
  row_count              integer,
  source_rows_updated_at timestamptz,
  error                  text,
  failed_at              timestamptz,
  last_success_at        timestamptz,
  PRIMARY KEY (property_id, dataset)
);
