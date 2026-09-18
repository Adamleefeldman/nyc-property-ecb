// Property records in Postgres: insert-or-return by canonical BBL, read back,
// and the small updates the resolver makes once it has looked the lot up.
// No network in this file.

import type pg from 'pg';
import { CONDO_UNIT_LOT_REASON, isCondoUnitLot, normalizeBbl } from './bbl.js';
import type { LotBuilding } from './footprints.js';

export type ResolutionStatus = 'resolved' | 'unresolved' | 'pending' | 'not_applicable';

/** Shape returned by the API (camelCase). SQL columns stay snake_case. */
export interface Property {
  id: string;
  bbl: string;
  borough: number;
  block: string;
  lot: string;
  normalizedAddress: string | null;
  /** Usable BINs only; placeholders (…000000) are stored but not listed. */
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
         (SELECT array_agg(b.bin ORDER BY b.bin)
            FROM property_bins b
           WHERE b.property_id = p.id AND NOT b.is_placeholder) AS bins
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

type Queryable = pg.Pool | pg.PoolClient;

export async function getProperty(db: Queryable, id: string): Promise<Property | null> {
  const { rows } = await db.query<PropertyRow>(`${PROPERTY_SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? toProperty(rows[0]) : null;
}

export interface UpsertResult {
  property: Property;
  created: boolean;
}

/**
 * Insert a property from a BBL string, or return the existing one. Idempotent:
 * the same lot, in any spelling, always maps to the same row. A new non-condo
 * property starts as `pending`; the resolver moves it on once it has asked
 * Footprints which buildings are on the lot. Throws InvalidBblError on bad input.
 */
export async function upsertPropertyByBbl(db: pg.Pool, rawInput: string): Promise<UpsertResult> {
  const { bbl, borough, block, lot } = normalizeBbl(rawInput);

  // A raw unit-lot BBL cannot be mapped to its building by any of our sources.
  // Store it, say why, and make no network call.
  const condoUnit = isCondoUnitLot(lot);
  const status: ResolutionStatus = condoUnit ? 'unresolved' : 'pending';
  const reason = condoUnit ? CONDO_UNIT_LOT_REASON : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO properties (bbl, borough, block, lot, resolution_status, resolution_source, resolution_reason)
       VALUES ($1, $2, $3, $4, $5, 'bbl', $6)
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

    const property = (await getProperty(client, id))!;
    await client.query('COMMIT');
    return { property, created };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record what Footprints said about the lot and settle the resolution status
 * in one transaction: usable BINs → resolved; none → not_applicable.
 */
export async function storeLotBuildings(db: pg.Pool, id: string, buildings: LotBuilding[]): Promise<Property> {
  const usable = buildings.filter((b) => !b.isPlaceholder).length;
  const status: ResolutionStatus = usable > 0 ? 'resolved' : 'not_applicable';
  const reason =
    usable > 0 ? null
    : buildings.length > 0 ? 'only placeholder BINs on lot (Building Footprints)'
    : 'no buildings on lot (Building Footprints)';

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const b of buildings) {
      await client.query(
        `INSERT INTO property_bins (property_id, bin, is_placeholder, source)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (property_id, bin) DO NOTHING`,
        [id, b.bin, b.isPlaceholder, `footprints:${b.source}`],
      );
    }
    await client.query(
      `UPDATE properties
          SET resolution_status = $2, resolution_reason = $3, resolved_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, status, reason],
    );
    const property = (await getProperty(client, id))!;
    await client.query('COMMIT');
    return property;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The lookup failed (source down, timeout). Keep the property; say why; retry later. */
export async function markPending(db: pg.Pool, id: string, error: string): Promise<Property> {
  await db.query(
    `UPDATE properties
        SET resolution_status = 'pending', resolution_reason = $2, updated_at = now()
      WHERE id = $1`,
    [id, error],
  );
  return (await getProperty(db, id))!;
}
