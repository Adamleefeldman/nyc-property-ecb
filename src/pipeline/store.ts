// Postgres writes for the pipeline: runs, raw rows, normalized rows, coverage.
// Rows go in as one JSON array per statement (jsonb_to_recordset), so a page
// of 1,000 violations is two round trips, not two thousand.

import type pg from 'pg';
import type { EcbRow } from './ecb-source.js';
import type { NormalizedViolation } from './normalize.js';

type Queryable = pg.Pool | pg.PoolClient;

export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed';

export async function startRun(db: Queryable, trigger: string, sourceRowsUpdatedAt: Date | null, callsSoFar = 0): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ingestion_runs (trigger, status, source_rows_updated_at, socrata_calls)
     VALUES ($1, 'running', $2, $3) RETURNING id`,
    [trigger, sourceRowsUpdatedAt, callsSoFar],
  );
  return Number(rows[0]!.id);
}

/** Untouched payloads, keyed on the violation number. Re-fetching the same row just refreshes fetched_at. */
export async function upsertRaw(db: Queryable, rows: EcbRow[], runId: number): Promise<void> {
  if (rows.length === 0) return;
  const records = rows.map((r) => ({
    ecb_violation_number: r.ecb_violation_number!.trim(),
    socrata_id: r[':id'],
    socrata_created_at: r[':created_at'] ?? null,
    socrata_updated_at: r[':updated_at'] ?? null,
    payload: r,
  }));
  await db.query(
    `INSERT INTO ecb_violations_raw (ecb_violation_number, socrata_id, socrata_created_at, socrata_updated_at, payload, run_id)
     SELECT r.ecb_violation_number, r.socrata_id, r.socrata_created_at, r.socrata_updated_at, r.payload, $2
       FROM jsonb_to_recordset($1::jsonb) AS r(
         ecb_violation_number text, socrata_id text, socrata_created_at timestamptz,
         socrata_updated_at timestamptz, payload jsonb)
     ON CONFLICT (ecb_violation_number) DO UPDATE SET
       socrata_id = EXCLUDED.socrata_id,
       socrata_created_at = EXCLUDED.socrata_created_at,
       socrata_updated_at = EXCLUDED.socrata_updated_at,
       payload = EXCLUDED.payload,
       fetched_at = now(),
       run_id = EXCLUDED.run_id`,
    [JSON.stringify(records), runId],
  );
}

export interface UpsertCounts {
  stored: number;
  inserted: number;
  changed: number;
}

/**
 * Typed rows. `updated_at` moves only when the served values (content_hash)
 * differ, so "changed since" queries are honest. With a runId the seen
 * markers advance; renormalize passes null and leaves them alone.
 */
export async function upsertNormalized(
  db: Queryable,
  rows: NormalizedViolation[],
  runId: number | null,
): Promise<UpsertCounts> {
  if (rows.length === 0) return { stored: 0, inserted: 0, changed: 0 };
  const { rows: out } = await db.query<{ inserted: boolean; changed: boolean }>(
    `INSERT INTO ecb_violations (
       ecb_violation_number, bin, bbl, borough, block, lot, status,
       issue_date, served_date, hearing_date, hearing_status, certification_status,
       severity, violation_type, violation_description, respondent_name,
       penalty_imposed, amount_paid, balance_due, dob_violation_number,
       infraction_code, section_law_description, aggravated_level, content_hash,
       first_seen_run_id, last_seen_run_id)
     SELECT r.ecb_violation_number, r.bin, r.bbl, r.borough, r.block, r.lot, r.status,
            r.issue_date, r.served_date, r.hearing_date, r.hearing_status, r.certification_status,
            r.severity, r.violation_type, r.violation_description, r.respondent_name,
            r.penalty_imposed, r.amount_paid, r.balance_due, r.dob_violation_number,
            r.infraction_code, r.section_law_description, r.aggravated_level, r.content_hash,
            COALESCE($2, raw.run_id), COALESCE($2, raw.run_id)
       FROM jsonb_to_recordset($1::jsonb) AS r(
         ecb_violation_number text, bin text, bbl char(10), borough smallint, block char(5), lot char(4),
         status text, issue_date date, served_date date, hearing_date date, hearing_status text,
         certification_status text, severity text, violation_type text, violation_description text,
         respondent_name text, penalty_imposed numeric, amount_paid numeric, balance_due numeric,
         dob_violation_number text, infraction_code text, section_law_description text,
         aggravated_level text, content_hash text)
       JOIN ecb_violations_raw raw USING (ecb_violation_number)
     ON CONFLICT (ecb_violation_number) DO UPDATE SET
       bin = EXCLUDED.bin, bbl = EXCLUDED.bbl, borough = EXCLUDED.borough, block = EXCLUDED.block, lot = EXCLUDED.lot,
       status = EXCLUDED.status, issue_date = EXCLUDED.issue_date, served_date = EXCLUDED.served_date,
       hearing_date = EXCLUDED.hearing_date, hearing_status = EXCLUDED.hearing_status,
       certification_status = EXCLUDED.certification_status, severity = EXCLUDED.severity,
       violation_type = EXCLUDED.violation_type, violation_description = EXCLUDED.violation_description,
       respondent_name = EXCLUDED.respondent_name, penalty_imposed = EXCLUDED.penalty_imposed,
       amount_paid = EXCLUDED.amount_paid, balance_due = EXCLUDED.balance_due,
       dob_violation_number = EXCLUDED.dob_violation_number, infraction_code = EXCLUDED.infraction_code,
       section_law_description = EXCLUDED.section_law_description, aggravated_level = EXCLUDED.aggravated_level,
       content_hash = EXCLUDED.content_hash,
       last_seen_run_id = COALESCE($2, ecb_violations.last_seen_run_id),
       absent_since_run_id = CASE WHEN $2 IS NULL THEN ecb_violations.absent_since_run_id ELSE NULL END,
       updated_at = CASE WHEN ecb_violations.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                         THEN now() ELSE ecb_violations.updated_at END
     RETURNING (xmax = 0) AS inserted, (updated_at = now()) AS changed`,
    [JSON.stringify(rows), runId],
  );
  const inserted = out.filter((r) => r.inserted).length;
  const changed = out.filter((r) => r.changed && !r.inserted).length;
  return { stored: out.length, inserted, changed };
}

export async function markCovered(
  db: Queryable,
  propertyId: string,
  runId: number,
  rowCount: number,
  sourceRowsUpdatedAt: Date | null,
): Promise<void> {
  await db.query(
    `INSERT INTO property_coverage (property_id, state, checked_at, run_id, row_count, source_rows_updated_at, last_success_at)
     VALUES ($1, 'checked', now(), $2, $3, $4, now())
     ON CONFLICT (property_id, dataset) DO UPDATE SET
       state = 'checked', checked_at = now(), run_id = EXCLUDED.run_id, row_count = EXCLUDED.row_count,
       source_rows_updated_at = EXCLUDED.source_rows_updated_at, error = NULL, failed_at = NULL,
       last_success_at = now()`,
    [propertyId, runId, rowCount, sourceRowsUpdatedAt],
  );
}

/** Keep the last successful check's fields; record that this attempt failed. */
export async function markCoverageFailed(db: Queryable, propertyId: string, runId: number, error: string): Promise<void> {
  await db.query(
    `INSERT INTO property_coverage (property_id, state, run_id, error, failed_at)
     VALUES ($1, 'failed', $2, $3, now())
     ON CONFLICT (property_id, dataset) DO UPDATE SET
       state = 'failed', run_id = EXCLUDED.run_id, error = EXCLUDED.error, failed_at = now()`,
    [propertyId, runId, error],
  );
}

// ---------------------------------------------------------------------------
// Batches: the unit of work and of resume.

export interface BatchRow {
  batch_no: number;
  bins: string[];
  property_ids: string[];
  attempts: number;
}

export async function insertBatches(
  db: Queryable,
  runId: number,
  batches: Array<{ batchNo: number; bins: string[]; propertyIds: string[] }>,
): Promise<void> {
  if (batches.length === 0) return;
  await db.query(
    `INSERT INTO ingestion_batches (run_id, batch_no, bins, property_ids, status)
     SELECT $1, b.batch_no, b.bins, b.property_ids, 'pending'
       FROM jsonb_to_recordset($2::jsonb) AS b(batch_no integer, bins text[], property_ids uuid[])`,
    [runId, JSON.stringify(batches.map((b) => ({ batch_no: b.batchNo, bins: b.bins, property_ids: b.propertyIds })))],
  );
  await db.query('UPDATE ingestion_runs SET batches_total = $2 WHERE id = $1', [runId, batches.length]);
}

export async function listPendingBatches(db: Queryable, runId: number): Promise<BatchRow[]> {
  const { rows } = await db.query<BatchRow>(
    `SELECT batch_no, bins, property_ids, attempts FROM ingestion_batches
      WHERE run_id = $1 AND status = 'pending' ORDER BY batch_no`,
    [runId],
  );
  return rows;
}

export async function markBatchStarted(db: Queryable, runId: number, batchNo: number): Promise<void> {
  await db.query(
    `UPDATE ingestion_batches SET attempts = attempts + 1, started_at = COALESCE(started_at, now())
      WHERE run_id = $1 AND batch_no = $2`,
    [runId, batchNo],
  );
}

export async function markBatchDone(
  db: Queryable,
  runId: number,
  batchNo: number,
  outcome: { status: 'succeeded'; rows: number } | { status: 'failed'; error: string },
): Promise<void> {
  await db.query(
    `UPDATE ingestion_batches SET status = $3, rows = $4, error = $5, finished_at = now()
      WHERE run_id = $1 AND batch_no = $2`,
    [runId, batchNo, outcome.status, outcome.status === 'succeeded' ? outcome.rows : null, outcome.status === 'failed' ? outcome.error : null],
  );
}

/** Rows for these BINs that this run did not see: the city stopped returning them. Flag, keep, still serve. */
export async function flagAbsent(db: Queryable, runId: number, bins: string[]): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE ecb_violations SET absent_since_run_id = $1
      WHERE bin = ANY($2) AND last_seen_run_id <> $1 AND absent_since_run_id IS NULL`,
    [runId, bins],
  );
  return rowCount ?? 0;
}

/** Counters advance per batch so a resumed run keeps what earlier batches did. */
export async function addRunCounts(
  db: Queryable,
  runId: number,
  add: {
    rowsFetched: number;
    rowsStored: number;
    rowsNew: number;
    rowsChanged: number;
    propertiesChecked: number;
    batchesFailed: number;
    socrataCalls: number;
  },
): Promise<void> {
  await db.query(
    `UPDATE ingestion_runs
        SET rows_fetched = rows_fetched + $2, rows_stored = rows_stored + $3, rows_new = rows_new + $4,
            rows_changed = rows_changed + $5, properties_checked = properties_checked + $6, batches_failed = batches_failed + $7,
            socrata_calls = socrata_calls + $8
      WHERE id = $1`,
    [runId, add.rowsFetched, add.rowsStored, add.rowsNew, add.rowsChanged, add.propertiesChecked, add.batchesFailed, add.socrataCalls],
  );
}

export interface RunRow {
  id: number;
  status: RunStatus;
  trigger: string;
  started_at: Date;
  finished_at: Date | null;
  source_rows_updated_at: Date | null;
  socrata_calls: number;
  rows_fetched: number;
  rows_stored: number;
  rows_new: number;
  rows_changed: number;
  properties_checked: number;
  batches_total: number;
  batches_failed: number;
  error: string | null;
}

export async function getRun(db: Queryable, runId: number): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>('SELECT * FROM ingestion_runs WHERE id = $1', [runId]);
  const r = rows[0];
  return r ? { ...r, id: Number(r.id) } : null;
}

/** The most recent run, if it never finished (the process died mid-run). */
export async function findUnfinishedRun(db: Queryable): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>(
    `SELECT * FROM ingestion_runs WHERE dataset = 'ecb' ORDER BY id DESC LIMIT 1`,
  );
  const r = rows[0];
  return r && r.status === 'running' ? { ...r, id: Number(r.id) } : null;
}

export async function closeRun(db: Queryable, runId: number, status: RunStatus, error: string | null): Promise<void> {
  await db.query(`UPDATE ingestion_runs SET status = $2, finished_at = now(), error = $3 WHERE id = $1`, [runId, status, error]);
}

export async function listRuns(db: Queryable, limit: number): Promise<RunRow[]> {
  const { rows } = await db.query<RunRow>(
    `SELECT * FROM ingestion_runs WHERE dataset = 'ecb' ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** When data was last refreshed end to end (a succeeded or partial run). */
export async function lastSuccessfulRunAt(db: Queryable): Promise<Date | null> {
  const { rows } = await db.query<{ finished_at: Date }>(
    `SELECT finished_at FROM ingestion_runs
      WHERE dataset = 'ecb' AND status IN ('succeeded', 'partial') ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.finished_at ?? null;
}
