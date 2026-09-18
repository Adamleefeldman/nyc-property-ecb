// Postgres writes for the pipeline: runs, raw rows, normalized rows, coverage.
// Rows go in as one JSON array per statement (jsonb_to_recordset), so a page
// of 1,000 violations is two round trips, not two thousand.

import type pg from 'pg';
import type { EcbRow } from './ecb-source.js';
import type { NormalizedViolation } from './normalize.js';

type Queryable = pg.Pool | pg.PoolClient;

export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed';

export async function startRun(db: Queryable, trigger: string, sourceRowsUpdatedAt: Date | null): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ingestion_runs (trigger, status, source_rows_updated_at)
     VALUES ($1, 'running', $2) RETURNING id`,
    [trigger, sourceRowsUpdatedAt],
  );
  return Number(rows[0]!.id);
}

export interface RunTotals {
  socrataCalls: number;
  rowsFetched: number;
  rowsStored: number;
  rowsNew: number;
  rowsChanged: number;
  propertiesChecked: number;
  batchesFailed: number;
}

export async function finishRun(
  db: Queryable,
  runId: number,
  status: RunStatus,
  totals: RunTotals,
  error: string | null = null,
): Promise<void> {
  await db.query(
    `UPDATE ingestion_runs
        SET status = $2, finished_at = now(), socrata_calls = $3, rows_fetched = $4, rows_stored = $5,
            rows_new = $6, rows_changed = $7, properties_checked = $8, batches_failed = $9, error = $10
      WHERE id = $1`,
    [
      runId,
      status,
      totals.socrataCalls,
      totals.rowsFetched,
      totals.rowsStored,
      totals.rowsNew,
      totals.rowsChanged,
      totals.propertiesChecked,
      totals.batchesFailed,
      error,
    ],
  );
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
