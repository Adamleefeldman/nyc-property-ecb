// One pipeline run: for every tracked property with usable BINs, fetch its
// ECB rows and file them. Each property is its own unit of work today; step 7
// groups BINs into batches and makes runs resumable.

import type pg from 'pg';
import type { SocrataClient } from '../socrata/fetch.js';
import { ECB_DATASET, fetchViolations, type EcbRow, type FetchOptions } from './ecb-source.js';
import { normalizeViolation, type NormalizedViolation } from './normalize.js';
import {
  finishRun,
  markCoverageFailed,
  markCovered,
  startRun,
  upsertNormalized,
  upsertRaw,
  type RunStatus,
  type RunTotals,
} from './store.js';

export interface IngestOptions extends FetchOptions {
  trigger: 'cli' | 'scheduler' | 'api';
}

export interface RunSummary extends RunTotals {
  runId: number;
  status: RunStatus;
  wallMs: number;
  sourceRowsUpdatedAt: Date | null;
}

interface TrackedProperty {
  id: string;
  bbl: string;
  bins: string[];
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

/** Drop rows we cannot key, and keep one per violation number so ON CONFLICT sees each once. */
function dedupe(rows: EcbRow[]): EcbRow[] {
  const seen = new Map<string, EcbRow>();
  for (const r of rows) {
    const key = r.ecb_violation_number?.trim();
    if (key) seen.set(key, r);
  }
  return [...seen.values()];
}

export async function runIngestion(db: pg.Pool, socrata: SocrataClient, opts: IngestOptions): Promise<RunSummary> {
  const startedAt = Date.now();
  const callsBefore = socrata.stats().calls;

  let sourceRowsUpdatedAt: Date | null = null;
  try {
    sourceRowsUpdatedAt = await socrata.getRowsUpdatedAt(ECB_DATASET);
  } catch {
    // Provenance only; a run without it is still a valid run.
  }
  const runId = await startRun(db, opts.trigger, sourceRowsUpdatedAt);

  const totals: RunTotals = {
    socrataCalls: 0,
    rowsFetched: 0,
    rowsStored: 0,
    rowsNew: 0,
    rowsChanged: 0,
    propertiesChecked: 0,
    batchesFailed: 0,
  };
  let fatal: string | null = null;

  try {
    for (const property of await trackedProperties(db)) {
      try {
        const raw = dedupe(await fetchViolations(socrata, property.bins, opts));
        const normalized = raw
          .map(normalizeViolation)
          .filter((r): r is NormalizedViolation => r !== null);

        const client = await db.connect();
        try {
          await client.query('BEGIN');
          await upsertRaw(client, raw, runId);
          const counts = await upsertNormalized(client, normalized, runId);
          await markCovered(client, property.id, runId, raw.length, sourceRowsUpdatedAt);
          await client.query('COMMIT');
          totals.rowsFetched += raw.length;
          totals.rowsStored += counts.stored;
          totals.rowsNew += counts.inserted;
          totals.rowsChanged += counts.changed;
          totals.propertiesChecked += 1;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        // One property failing must not hide inside a run marked succeeded.
        totals.batchesFailed += 1;
        await markCoverageFailed(db, property.id, runId, (err as Error).message);
      }
    }
  } catch (err) {
    fatal = (err as Error).message;
  }

  totals.socrataCalls = socrata.stats().calls - callsBefore;
  const status: RunStatus = fatal ? 'failed' : totals.batchesFailed > 0 ? 'partial' : 'succeeded';
  await finishRun(db, runId, status, totals, fatal);

  return { runId, status, wallMs: Date.now() - startedAt, sourceRowsUpdatedAt, ...totals };
}

/** The one-line summary the README promises. */
export function formatSummary(s: RunSummary): string {
  const secs = (s.wallMs / 1000).toFixed(1);
  return (
    `run ${s.runId} ${s.status} in ${secs}s: ${s.socrataCalls} Socrata calls, ` +
    `${s.rowsFetched} rows fetched, ${s.rowsStored} stored (${s.rowsNew} new, ${s.rowsChanged} changed), ` +
    `${s.propertiesChecked} properties checked, ${s.batchesFailed} batches failed`
  );
}
