// Property records in Postgres. No network in this file.
//
// A property is normally a lot (has a bbl). An address that could not be
// geocoded yet is a property with no lot: bbl null, status pending or
// unresolved, so the caller gets an id and the input is never lost.

import type pg from 'pg';
import type { Bbl } from './bbl.js';
import type { LotBuilding } from './footprints.js';
import type { PlutoLot } from './pluto.js';

export type ResolutionStatus = 'resolved' | 'unresolved' | 'pending' | 'not_applicable';
export type InputKind = 'bbl' | 'address';

/** Shape returned by the API (camelCase). SQL columns stay snake_case. */
export interface Property {
  id: string;
  bbl: string | null;
  borough: number | null;
  block: string | null;
  lot: string | null;
  normalizedAddress: string | null;
  /** Usable BINs only; placeholders (…000000) are stored but not listed. */
  bins: string[];
  pluto: PlutoLot | null;
  resolution: {
    status: ResolutionStatus;
    source: string | null;
    at: string | null;
    reason?: string;
  };
}

interface PropertyRow {
  id: string;
  bbl: string | null;
  borough: number | null;
  block: string | null;
  lot: string | null;
  normalized_address: string | null;
  pluto: PlutoLot | null;
  resolution_status: ResolutionStatus;
  resolution_source: string | null;
  resolved_at: Date | null;
  resolution_reason: string | null;
  bins: string[] | null;
}

const PROPERTY_SELECT = `
  SELECT p.id, p.bbl, p.borough, p.block, p.lot, p.normalized_address, p.pluto,
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
    pluto: row.pluto,
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

/** The input-string cache: have we seen exactly this (kind, key) before? */
export async function findByInput(db: Queryable, kind: InputKind, inputKey: string): Promise<Property | null> {
  const { rows } = await db.query<PropertyRow>(
    `${PROPERTY_SELECT} JOIN property_inputs i ON i.property_id = p.id WHERE i.kind = $1 AND i.input_key = $2`,
    [kind, inputKey],
  );
  return rows[0] ? toProperty(rows[0]) : null;
}

export interface InputRef {
  kind: InputKind;
  inputKey: string;
  rawInput: string;
  unit?: string | null;
}

async function recordInput(db: Queryable, input: InputRef, propertyId: string): Promise<void> {
  await db.query(
    `INSERT INTO property_inputs (kind, input_key, raw_input, unit, property_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, input_key) DO UPDATE SET property_id = EXCLUDED.property_id`,
    [input.kind, input.inputKey, input.rawInput, input.unit ?? null, propertyId],
  );
}

async function withTransaction<T>(db: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface UpsertResult {
  property: Property;
  created: boolean;
}

export interface LotUpsert {
  input: InputRef;
  status: ResolutionStatus;
  reason: string | null;
  /** What turned the input into a lot: 'bbl' (given) or 'geosearch'. */
  source: 'bbl' | 'geosearch';
  normalizedAddress?: string | null;
  pluto?: PlutoLot | null;
}

/**
 * Insert a lot, or return the existing row for the same canonical bbl.
 * Idempotent: any spelling of the same lot maps to one row. On an existing
 * row, address and PLUTO facts are filled in if they were missing, never
 * overwritten. Optionally absorbs a lot-less pending row from the address path.
 */
export async function upsertLot(db: pg.Pool, lot: Bbl, opts: LotUpsert, absorbId: string | null = null): Promise<UpsertResult> {
  return withTransaction(db, async (client) => {
    if (absorbId) {
      // A lot-less pending row is waiting. If nobody holds this lot yet, the
      // pending row becomes the lot, so the id the caller was given stays valid.
      const held = await client.query('SELECT 1 FROM properties WHERE bbl = $1 AND id <> $2', [lot.bbl, absorbId]);
      if (held.rowCount === 0) {
        await client.query(
          `UPDATE properties
              SET bbl = $2, borough = $3, block = $4, lot = $5, resolution_status = $6, resolution_source = $7,
                  resolution_reason = $8, normalized_address = COALESCE(normalized_address, $9), pluto = COALESCE(pluto, $10),
                  updated_at = now()
            WHERE id = $1`,
          [absorbId, lot.bbl, lot.borough, lot.block, lot.lot, opts.status, opts.source, opts.reason, opts.normalizedAddress ?? null, opts.pluto ?? null],
        );
        await recordInput(client, opts.input, absorbId);
        return { property: (await getProperty(client, absorbId))!, created: false };
      }
    }
    const { rows } = await client.query<{ id: string; created: boolean }>(
      `INSERT INTO properties (bbl, borough, block, lot, resolution_status, resolution_source, resolution_reason, normalized_address, pluto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (bbl) DO UPDATE SET
         normalized_address = COALESCE(properties.normalized_address, EXCLUDED.normalized_address),
         pluto = COALESCE(properties.pluto, EXCLUDED.pluto),
         updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [lot.bbl, lot.borough, lot.block, lot.lot, opts.status, opts.source, opts.reason, opts.normalizedAddress ?? null, opts.pluto ?? null],
    );
    const { id, created } = rows[0]!;
    await recordInput(client, opts.input, id);
    if (absorbId && absorbId !== id) {
      // The address was pending under a lot-less row; its inputs now point at the real lot.
      await client.query(
        `UPDATE property_inputs SET property_id = $2 WHERE property_id = $1
           AND NOT EXISTS (SELECT 1 FROM property_inputs x WHERE x.kind = property_inputs.kind AND x.input_key = property_inputs.input_key AND x.property_id = $2)`,
        [absorbId, id],
      );
      await client.query('DELETE FROM properties WHERE id = $1', [absorbId]);
    }
    return { property: (await getProperty(client, id))!, created };
  });
}

/** An address with no lot yet: pending (source down) or unresolved (no exact match). */
export async function upsertAddressOnly(
  db: pg.Pool,
  input: InputRef,
  normalizedAddress: string,
  status: 'pending' | 'unresolved',
  reason: string,
  existingId: string | null,
): Promise<UpsertResult> {
  return withTransaction(db, async (client) => {
    let id = existingId;
    if (id) {
      await client.query(
        `UPDATE properties SET resolution_status = $2, resolution_reason = $3, updated_at = now() WHERE id = $1`,
        [id, status, reason],
      );
    } else {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO properties (resolution_status, resolution_source, resolution_reason, normalized_address)
         VALUES ($1, 'geosearch', $2, $3) RETURNING id`,
        [status, reason, normalizedAddress],
      );
      id = rows[0]!.id;
    }
    await recordInput(client, input, id);
    return { property: (await getProperty(client, id))!, created: existingId === null };
  });
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

  return withTransaction(db, async (client) => {
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
    return (await getProperty(client, id))!;
  });
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

/**
 * Every property that a retry might settle, with the input that created it:
 * pending (a source was down) and unresolved (no match at the time). Resolved
 * and not_applicable are final.
 */
export async function listRetryable(
  db: Queryable,
): Promise<Array<{ id: string; kind: InputKind; rawInput: string; status: ResolutionStatus }>> {
  const { rows } = await db.query<{ id: string; kind: InputKind; raw_input: string; resolution_status: ResolutionStatus }>(
    `SELECT DISTINCT ON (p.id) p.id, i.kind, i.raw_input, p.resolution_status
       FROM properties p JOIN property_inputs i ON i.property_id = p.id
      WHERE p.resolution_status IN ('pending', 'unresolved')
      ORDER BY p.id, i.created_at`,
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, rawInput: r.raw_input, status: r.resolution_status }));
}

// ---------------------------------------------------------------------------
// Bulk: many lots in one statement, then the caller settles BINs in batches.

export interface BulkLot {
  lot: Bbl;
  rawInputs: string[]; // every spelling that mapped to this lot in the request
  status: 'pending' | 'unresolved';
  reason: string | null;
}

export interface BulkUpsertRow {
  id: string;
  bbl: string;
  created: boolean;
  resolution_status: ResolutionStatus;
  has_bins: boolean;
}

/** Insert-or-return every lot in one round trip and record all their inputs in another. */
export async function upsertLotsBulk(db: pg.Pool, lots: BulkLot[]): Promise<BulkUpsertRow[]> {
  if (lots.length === 0) return [];
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<BulkUpsertRow>(
      `INSERT INTO properties (bbl, borough, block, lot, resolution_status, resolution_source, resolution_reason)
       SELECT l.bbl, l.borough, l.block, l.lot, l.status, 'bbl', l.reason
         FROM jsonb_to_recordset($1::jsonb) AS l(bbl char(10), borough smallint, block char(5), lot char(4), status text, reason text)
       ON CONFLICT (bbl) DO UPDATE SET updated_at = properties.updated_at
       RETURNING id, bbl, (xmax = 0) AS created, resolution_status,
                 EXISTS (SELECT 1 FROM property_bins b WHERE b.property_id = properties.id) AS has_bins`,
      [JSON.stringify(lots.map((l) => ({ ...l.lot, status: l.status, reason: l.reason })))],
    );
    const idByBbl = new Map(rows.map((r) => [r.bbl, r.id]));
    const inputs = lots.flatMap((l) =>
      l.rawInputs.map((raw) => ({ kind: 'bbl', input_key: raw.trim(), raw_input: raw, property_id: idByBbl.get(l.lot.bbl)! })),
    );
    await client.query(
      `INSERT INTO property_inputs (kind, input_key, raw_input, property_id)
       SELECT i.kind, i.input_key, i.raw_input, i.property_id
         FROM jsonb_to_recordset($1::jsonb) AS i(kind text, input_key text, raw_input text, property_id uuid)
       ON CONFLICT (kind, input_key) DO NOTHING`,
      [JSON.stringify(inputs)],
    );
    return rows;
  });
}
