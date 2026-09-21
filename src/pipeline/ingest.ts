// One pipeline run, in batches, resumable.
//
//   lock → plan (or adopt the unfinished run) → for each pending batch:
//   fetch → upsert raw + normalized → flag absent → coverage → mark batch
//   → close the run as succeeded / partial / failed → unlock.
//
// The plan is written to ingestion_batches before the first fetch, so a
// process that dies mid-run leaves a run marked `running` with pending
// batches, and the next start continues it. Succeeded batches never refetch.

import type pg from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { SocrataClient } from '../socrata/fetch.js';
import { ECB_DATASET, fetchViolations, type EcbRow, type FetchOptions } from './ecb-source.js';
import { normalizeViolation, type NormalizedViolation } from './normalize.js';
import { planBatches, type TrackedProperty } from './planner.js';
import {
  addRunCounts,
  closeRun,
  findUnfinishedRun,
  flagAbsent,
  getRun,
  insertBatches,
  listPendingBatches,
  markBatchDone,
  markBatchStarted,
  markCoverageFailed,
  markCovered,
  startRun,
  upsertNormalized,
  upsertRaw,
  type RunRow,
  type RunStatus,
} from './store.js';

const RUN_LOCK_KEY = 7_364_002; // advisory lock: one ECB run at a time, released by Postgres if we die

export interface IngestOptions extends FetchOptions {
  trigger: 'cli' | 'scheduler' | 'api';
  batchSize: number;
  /** Test knobs: make batch n throw; call after batch n (the CLI uses it to exit). */
  failBatch?: number | undefined;
  afterBatch?: ((batchNo: number) => Promise<void> | void) | undefined;
}

export interface RunSummary {
  runId: number;
  status: RunStatus;
  resumed: boolean;
  wallMs: number;
  sourceRowsUpdatedAt: Date | null;
  socrataCalls: number;
  rowsFetched: number;
  rowsStored: number;
  rowsNew: number;
  rowsChanged: number;
  rowsAbsent: number;
  propertiesChecked: number;
  batchesTotal: number;
  batchesFailed: number;
}

export class RunInProgressError extends Error {
  constructor() {
    super('an ingestion run is already in progress');
    this.name = 'RunInProgressError';
  }
}

async function trackedProperties(db: pg.Pool): Promise<TrackedProperty[]> {
  const { rows } = await db.query<TrackedProperty>(
    `SELECT p.id, p.bbl, array_agg(b.bin ORDER BY b.bin) AS bins
       FROM properties p
       JOIN property_bins b ON b.property_id = p.id AND NOT b.is_placeholder
      WHERE p.resolution_status = 'resolved'
      GROUP BY p.id, p.bbl
      ORDER BY p.bbl`,
  );
  return rows;
}

/** Which BINs belong to each property in this batch, for per-property row counts. */
async function binsByProperty(db: pg.Pool, propertyIds: string[]): Promise<Map<string, string[]>> {
  const { rows } = await db.query<{ property_id: string; bin: string }>(
    `SELECT property_id, bin FROM property_bins WHERE property_id = ANY($1) AND NOT is_placeholder`,
    [propertyIds],
  );
  const map = new Map<string, string[]>(propertyIds.map((id) => [id, []]));
  for (const r of rows) map.get(r.property_id)?.push(r.bin);
  return map;
}

/** Drop rows we cannot key, and keep one per violation number so ON CONFLICT sees each once. */
function dedupe(rows: EcbRow[]): EcbRow[] {
  const seen = new Map<string, EcbRow>();
  for (const r of rows) {
    const key = r.ecb_violation_number?.trim();
    if (key) seen.set(key, r);
  }
  return [...seen.values()];
}

async function withRunLock<T>(db: pg.Pool, fn: () => Promise<T>): Promise<T> {
  // The lock lives on this one connection for the whole run.
  const holder = await db.connect();
  try {
    const { rows } = await holder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RUN_LOCK_KEY]);
    if (!rows[0]?.locked) throw new RunInProgressError();
    try {
      return await fn();
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [RUN_LOCK_KEY]);
    }
  } finally {
    holder.release();
  }
}

/** Start a new run with a fresh plan, or adopt the last run if it never finished. */
async function openRun(db: pg.Pool, socrata: SocrataClient, opts: IngestOptions): Promise<{ run: RunRow; resumed: boolean }> {
  const unfinished = await findUnfinishedRun(db);
  if (unfinished) return { run: unfinished, resumed: true };

  let sourceRowsUpdatedAt: Date | null = null;
  const callsBefore = socrata.stats().calls;
  try {
    sourceRowsUpdatedAt = await socrata.getRowsUpdatedAt(ECB_DATASET);
  } catch {
    // Provenance only; a run without it is still a valid run.
  }
  // Run row and its plan commit together: a run never exists without its batches.
  const metadataCalls = socrata.stats().calls - callsBefore;
  const plan = planBatches(await trackedProperties(db), opts.batchSize);
  const runId = await withTransaction(db, async (client) => {
    const id = await startRun(client, opts.trigger, sourceRowsUpdatedAt, metadataCalls);
    await insertBatches(client, id, plan);
    return id;
  });
  return { run: (await getRun(db, runId))!, resumed: false };
}

export async function runIngestion(db: pg.Pool, socrata: SocrataClient, opts: IngestOptions): Promise<RunSummary> {
  const startedAt = Date.now();

  return withRunLock(db, async () => {
    const { run, resumed } = await openRun(db, socrata, opts);
    const runId = run.id;
    let rowsAbsent = 0;
    let fatal: string | null = null;

    let pending: Awaited<ReturnType<typeof listPendingBatches>> = [];
    try {
      pending = await listPendingBatches(db, runId);
    } catch (err) {
      fatal = (err as Error).message;
    }

    for (const batch of pending) {
      try {
        await markBatchStarted(db, runId, batch.batch_no);
        const callsBefore = socrata.stats().calls;
        try {
          if (opts.failBatch === batch.batch_no) throw new Error(`INGEST_FAIL_BATCH=${batch.batch_no} (test knob)`);
          const raw = dedupe(await fetchViolations(socrata, batch.bins, opts));
          const normalized = raw.map(normalizeViolation).filter((r): r is NormalizedViolation => r !== null);
          const perProperty = await binsByProperty(db, batch.property_ids);

          const client = await db.connect();
          try {
            await client.query('BEGIN');
            await upsertRaw(client, raw, runId);
            const counts = await upsertNormalized(client, normalized, runId);
            rowsAbsent += await flagAbsent(client, runId, batch.bins);
            for (const [propertyId, bins] of perProperty) {
              const rowCount = raw.filter((r) => r.bin !== undefined && bins.includes(String(r.bin))).length;
              await markCovered(client, propertyId, runId, rowCount, run.source_rows_updated_at);
            }
            await markBatchDone(client, runId, batch.batch_no, { status: 'succeeded', rows: raw.length });
            await addRunCounts(client, runId, {
              rowsFetched: raw.length,
              rowsStored: counts.stored,
              rowsNew: counts.inserted,
              rowsChanged: counts.changed,
              propertiesChecked: perProperty.size,
              batchesFailed: 0,
              socrataCalls: socrata.stats().calls - callsBefore,
            });
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }
        } catch (err) {
          // One batch failing must not hide inside a run marked succeeded.
          const message = (err as Error).message;
          await markBatchDone(db, runId, batch.batch_no, { status: 'failed', error: message });
          for (const propertyId of batch.property_ids) await markCoverageFailed(db, propertyId, runId, message);
          await addRunCounts(db, runId, {
            rowsFetched: 0,
            rowsStored: 0,
            rowsNew: 0,
            rowsChanged: 0,
            propertiesChecked: 0,
            batchesFailed: 1,
            socrataCalls: socrata.stats().calls - callsBefore,
          });
        }
      } catch (err) {
        // Bookkeeping itself failed (database gone?): close the run as failed.
        fatal = (err as Error).message;
        break;
      }
      // Outside the guard on purpose: the hook stands in for the process dying
      // (the CLI exits here), and a dead process closes nothing.
      if (opts.afterBatch) await opts.afterBatch(batch.batch_no);
    }

    const before = (await getRun(db, runId))!;
    const status: RunStatus = fatal ? 'failed' : before.batches_failed > 0 ? 'partial' : 'succeeded';
    await closeRun(db, runId, status, fatal);
    const final = (await getRun(db, runId))!;

    return {
      runId,
      status,
      resumed,
      wallMs: Date.now() - startedAt,
      sourceRowsUpdatedAt: final.source_rows_updated_at,
      socrataCalls: final.socrata_calls,
      rowsFetched: final.rows_fetched,
      rowsStored: final.rows_stored,
      rowsNew: final.rows_new,
      rowsChanged: final.rows_changed,
      rowsAbsent,
      propertiesChecked: final.properties_checked,
      batchesTotal: final.batches_total,
      batchesFailed: final.batches_failed,
    };
  });
}

/** The one-line summary the README promises. */
export function formatSummary(s: RunSummary): string {
  const secs = (s.wallMs / 1000).toFixed(1);
  return (
    `run ${s.runId}${s.resumed ? ' (resumed)' : ''} ${s.status} in ${secs}s: ${s.socrataCalls} Socrata calls, ` +
    `${s.batchesTotal} batches (${s.batchesFailed} failed), ${s.rowsFetched} rows fetched, ` +
    `${s.rowsStored} stored (${s.rowsNew} new, ${s.rowsChanged} changed, ${s.rowsAbsent} absent), ` +
    `${s.propertiesChecked} properties checked`
  );
}
