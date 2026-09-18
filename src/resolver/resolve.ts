// The resolver: input → stored property with its buildings identified.
// Two entry points, one exit: the address path ends by joining the BBL path,
// so "350 5th Avenue, Manhattan" and "1008350041" are one record.

import type pg from 'pg';
import type { SocrataClient } from '../socrata/fetch.js';
import { InvalidAddressError, normalizeAddress } from './address.js';
import { CONDO_UNIT_LOT_REASON, isCondoUnitLot, normalizeBbl, type Bbl } from './bbl.js';
import { lookupBins } from './footprints.js';
import { GeoSearchError, resolveAddress, type GeoSearchClient } from './geosearch.js';
import { fetchPlutoLot } from './pluto.js';
import {
  findByInput,
  markPending,
  storeLotBuildings,
  upsertAddressOnly,
  upsertLot,
  type InputRef,
  type Property,
} from './properties.js';

export interface ResolverDeps {
  socrata: SocrataClient;
  geosearch: GeoSearchClient;
}

export interface RegisterResult {
  property: Property;
  /** 201 created, 200 already known, 202 stored but a lookup must be retried. */
  httpStatus: 201 | 200 | 202;
}

/** Does this record still need a trip to Footprints? */
function needsBins(p: Property): boolean {
  if (p.bbl === null) return false;
  if (p.resolution.status === 'pending') return true;
  // Records written before BIN lookup existed: resolved on paper, no buildings yet.
  return p.resolution.status === 'resolved' && p.bins.length === 0;
}

/** Step 3: ask Footprints which buildings sit on the lot, and settle the status. */
async function settleBins(db: pg.Pool, socrata: SocrataClient, property: Property, base: 201 | 200): Promise<RegisterResult> {
  if (!needsBins(property)) return { property, httpStatus: base };
  try {
    const buildings = await lookupBins(socrata, property.bbl!);
    return { property: await storeLotBuildings(db, property.id, buildings), httpStatus: base };
  } catch (err) {
    // The row is already committed; nothing the caller sent is lost.
    const message = `Building Footprints lookup failed: ${(err as Error).message}`;
    return { property: await markPending(db, property.id, message), httpStatus: 202 };
  }
}

export async function registerByBbl(db: pg.Pool, deps: Pick<ResolverDeps, 'socrata'>, rawInput: string): Promise<RegisterResult> {
  const lot = normalizeBbl(rawInput);
  const input: InputRef = { kind: 'bbl', inputKey: rawInput.trim(), rawInput };

  // A raw unit-lot BBL cannot be mapped to its building by any of our sources.
  const condoUnit = isCondoUnitLot(lot.lot);
  const { property, created } = await upsertLot(db, lot, {
    input,
    source: 'bbl',
    status: condoUnit ? 'unresolved' : 'pending',
    reason: condoUnit ? CONDO_UNIT_LOT_REASON : null,
  });
  return settleBins(db, deps.socrata, property, created ? 201 : 200);
}

export async function registerByAddress(db: pg.Pool, deps: ResolverDeps, rawInput: string): Promise<RegisterResult> {
  const address = normalizeAddress(rawInput); // throws InvalidAddressError → 400
  const input: InputRef = { kind: 'address', inputKey: address.inputKey, rawInput, unit: address.unit };

  // Seen this exact address before? Then no geocoding, unless it is still pending.
  const known = await findByInput(db, 'address', address.inputKey);
  if (known && known.resolution.status !== 'pending') {
    return settleBins(db, deps.socrata, known, 200);
  }
  const pendingId = known?.id ?? null;

  let match;
  try {
    match = await resolveAddress(deps.geosearch, address);
  } catch (err) {
    if (!(err instanceof GeoSearchError)) throw err;
    const reason = `GeoSearch unavailable: ${err.message}`;
    const { property } = await upsertAddressOnly(db, input, address.normalized, 'pending', reason, pendingId);
    return { property, httpStatus: 202 };
  }

  if (match.kind === 'unresolved') {
    const { property, created } = await upsertAddressOnly(db, input, address.normalized, 'unresolved', match.reason, pendingId);
    return { property, httpStatus: created ? 201 : 200 };
  }

  // A verified lot. PLUTO facts are nice to have; a miss or an outage is not a failure.
  const lot: Bbl = normalizeBbl(match.bbl);
  let pluto = null;
  try {
    pluto = await fetchPlutoLot(deps.socrata, lot.bbl);
  } catch {
    /* provenance only */
  }
  const { property, created } = await upsertLot(
    db,
    lot,
    { input, source: 'geosearch', status: 'pending', reason: null, normalizedAddress: address.normalized, pluto },
    pendingId,
  );
  return settleBins(db, deps.socrata, property, created && !pendingId ? 201 : 200);
}

export { InvalidAddressError };
