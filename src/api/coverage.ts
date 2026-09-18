// The envelope every violations response carries: did we check this
// property, when, and how fresh was the source. An empty list without this
// is the wrong answer, because "none" and "unknown" look the same.

import type pg from 'pg';
import type { Property } from '../resolver/properties.js';

export type Coverage =
  | { state: 'checked'; checkedAt: string; sourceUpdatedAt: string | null; runId: number }
  | { state: 'not_checked'; reason: string }
  | { state: 'not_applicable'; reason: string }
  | {
      state: 'failed';
      failedAt: string;
      error: string;
      runId: number;
      lastSuccessAt: string | null;
      sourceUpdatedAt: string | null;
    };

interface CoverageRow {
  state: 'checked' | 'failed';
  checked_at: Date | null;
  run_id: string | null;
  source_rows_updated_at: Date | null;
  error: string | null;
  failed_at: Date | null;
  last_success_at: Date | null;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function coverageFor(db: pg.Pool, property: Property): Promise<Coverage> {
  const { status, reason } = property.resolution;

  // No usable building ID means there is nothing to look up. Say why.
  if (status === 'not_applicable' || status === 'unresolved') {
    return { state: 'not_applicable', reason: reason ?? 'no usable building ID' };
  }

  const { rows } = await db.query<CoverageRow>(
    `SELECT state, checked_at, run_id, source_rows_updated_at, error, failed_at, last_success_at
       FROM property_coverage WHERE property_id = $1 AND dataset = 'ecb'`,
    [property.id],
  );
  const row = rows[0];

  if (!row) {
    return {
      state: 'not_checked',
      reason:
        status === 'pending'
          ? `building lookup still pending: ${reason ?? 'not attempted yet'}`
          : 'the pipeline has not reached this property yet',
    };
  }
  if (row.state === 'failed') {
    return {
      state: 'failed',
      failedAt: iso(row.failed_at)!,
      error: row.error ?? 'unknown error',
      runId: Number(row.run_id),
      lastSuccessAt: iso(row.last_success_at),
      sourceUpdatedAt: iso(row.source_rows_updated_at),
    };
  }
  return {
    state: 'checked',
    checkedAt: iso(row.checked_at)!,
    sourceUpdatedAt: iso(row.source_rows_updated_at),
    runId: Number(row.run_id),
  };
}
