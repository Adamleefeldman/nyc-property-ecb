// Property records: insert-or-return by canonical BBL, plus read back.
// Everything here is Postgres only; no network.

import type pg from 'pg';
import { CONDO_UNIT_LOT_REASON, isCondoUnitLot, normalizeBbl } from './bbl.js';

export type ResolutionStatus = 'resolved' | 'unresolved' | 'pending' | 'not_applicable';

/** Shape returned by the API (camelCase). SQL columns stay snake_case. */
export interface Property {
  id: string;
  bbl: string;
  borough: number;
  block: string;
  lot: string;
  normalizedAddress: string | null;
  bins: string[];
  resolution: {
    status: ResolutionStatus;
    source: string | null;
    at: string | null;
    reason?: string;
  };
}

interface PropertyRow {
  id: string;
  bbl: string;
  borough: number;
  block: string;
  lot: string;
  normalized_address: string | null;
  resolution_status: ResolutionStatus;
  resolution_source: string | null;
  resolved_at: Date | null;
  resolution_reason: string | null;
  bins: string[] | null;
}

const PROPERTY_SELECT = `
  SELECT p.id, p.bbl, p.borough, p.block, p.lot, p.normalized_address,
         p.resolution_status, p.resolution_source, p.resolved_at, p.resolution_reason,
         (SELECT array_agg(b.bin ORDER BY b.bin) FROM property_bins b WHERE b.property_id = p.id) AS bins
  FROM properties p
`;

function toProperty(row: PropertyRow): Property {
  return {
    id: row.id,
    bbl: row.bbl,
    borough: row.borough,
    block: row.block,
    lot: row.lot,
    normalizedAddress: row.normalized_address,
    bins: row.bins ?? [],
    resolution: {
      status: row.resolution_status,
      source: row.resolution_source,
      at: row.resolved_at?.toISOString() ?? null,
      ...(row.resolution_reason ? { reason: row.resolution_reason } : {}),
    },
  };
}

export async function getProperty(db: pg.Pool, id: string): Promise<Property | null> {
  const { rows } = await db.query<PropertyRow>(`${PROPERTY_SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? toProperty(rows[0]) : null;
}

export interface UpsertResult {
  property: Property;
  created: boolean;
}

/**
 * Register a property from a BBL string. Idempotent: the same lot, in any
 * spelling, always returns the same record. Throws InvalidBblError on bad input.
 */
export async function upsertPropertyByBbl(db: pg.Pool, rawInput: string): Promise<UpsertResult> {
  const { bbl, borough, block, lot } = normalizeBbl(rawInput);

  // A raw unit-lot BBL cannot be mapped to its building by any of our sources.
  // Store it, say why, and make no network call.
  const condoUnit = isCondoUnitLot(lot);
  const status: ResolutionStatus = condoUnit ? 'unresolved' : 'resolved';
  const reason = condoUnit ? CONDO_UNIT_LOT_REASON : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO properties (bbl, borough, block, lot, resolution_status, resolution_source, resolved_at, resolution_reason)
       VALUES ($1, $2, $3, $4, $5, 'bbl', CASE WHEN $5 = 'resolved' THEN now() END, $6)
       ON CONFLICT (bbl) DO NOTHING
       RETURNING id`,
      [bbl, borough, block, lot, status, reason],
    );
    const created = inserted.rowCount === 1;
    const id =
      inserted.rows[0]?.id ??
      (await client.query<{ id: string }>('SELECT id FROM properties WHERE bbl = $1', [bbl])).rows[0]!.id;

    // Keep exactly what the caller sent, once per distinct spelling.
    await client.query(
      `INSERT INTO property_inputs (kind, input_key, raw_input, property_id)
       VALUES ('bbl', $1, $2, $3)
       ON CONFLICT (kind, input_key) DO NOTHING`,
      [rawInput.trim(), rawInput, id],
    );

    const { rows } = await client.query<PropertyRow>(`${PROPERTY_SELECT} WHERE p.id = $1`, [id]);
    await client.query('COMMIT');
    return { property: toProperty(rows[0]!), created };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
