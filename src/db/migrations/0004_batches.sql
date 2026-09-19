-- The unit of work and of resume: a run is planned into batches of BINs
-- before any fetch, so a restart can continue from the first pending one.
CREATE TABLE ingestion_batches (
  run_id       bigint NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  batch_no     integer NOT NULL,
  bins         text[] NOT NULL,
  property_ids uuid[] NOT NULL,             -- whose coverage this batch settles
  status       text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  rows         integer,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  PRIMARY KEY (run_id, batch_no)
);
CREATE INDEX ingestion_batches_pending_idx ON ingestion_batches (run_id, batch_no) WHERE status = 'pending';

ALTER TABLE ingestion_runs ADD COLUMN batches_total integer NOT NULL DEFAULT 0;

-- A row the city stopped returning for a BIN we fetched. Kept, flagged, still served.
ALTER TABLE ecb_violations ADD COLUMN absent_since_run_id bigint REFERENCES ingestion_runs (id);
