// The resolver: input → stored property with its buildings identified.
// BBL path today; the address path (GeoSearch, PLUTO) arrives in step 6.

import type pg from 'pg';
import type { SocrataClient } from '../socrata/fetch.js';
import { lookupBins } from './footprints.js';
import { markPending, storeLotBuildings, upsertPropertyByBbl, type Property } from './properties.js';

export interface RegisterResult {
  property: Property;
  /** 201 created, 200 already known, 202 stored but the lookup must be retried. */
  httpStatus: 201 | 200 | 202;
}

/** Does this record still need a trip to Footprints? */
function needsLookup(p: Property): boolean {
  if (p.resolution.status === 'pending') return true;
  // Records written before BIN lookup existed: resolved on paper, no buildings yet.
  return p.resolution.status === 'resolved' && p.bins.length === 0;
}

export async function registerByBbl(db: pg.Pool, socrata: SocrataClient, rawInput: string): Promise<RegisterResult> {
  const { property, created } = await upsertPropertyByBbl(db, rawInput);
  const base = created ? 201 : 200;
  if (!needsLookup(property)) return { property, httpStatus: base };

  try {
    const buildings = await lookupBins(socrata, property.bbl);
    return { property: await storeLotBuildings(db, property.id, buildings), httpStatus: base };
  } catch (err) {
    // The row is already committed; nothing the caller sent is lost.
    const message = `Building Footprints lookup failed: ${(err as Error).message}`;
    return { property: await markPending(db, property.id, message), httpStatus: 202 };
  }
}
