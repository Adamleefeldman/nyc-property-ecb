// PLUTO (64uk-42ks): one row per lot with parcel facts, including the lot's
// official address. Stored as returned, in properties.pluto, for display and
// as the address of a lot registered by BBL (see plutoAddress). Not required
// for resolution, so a miss or an outage is not an error.

import { soqlString, type SocrataClient } from '../socrata/fetch.js';
import { BOROUGH_NAME } from './address.js';
import { normalizeBbl } from './bbl.js';

const PLUTO_DATASET = '64uk-42ks';
const FIELDS =
  'bbl,borough,block,lot,address,zipcode,bldgclass,landuse,ownername,numbldgs,numfloors,unitsres,unitstotal,yearbuilt,cd,lotarea,bldgarea';

export type PlutoLot = Record<string, string>;

/** PLUTO stores the BBL as a decimal, e.g. 1008350041.00000000. */
const plutoKey = (bbl: string) => soqlString(`${bbl}.00000000`);

export async function fetchPlutoLot(client: SocrataClient, bbl: string): Promise<PlutoLot | null> {
  const rows = await client.get<PlutoLot>(PLUTO_DATASET, {
    $select: FIELDS,
    $where: `bbl=${plutoKey(bbl)}`,
    $limit: '1',
  });
  return rows[0] ?? null;
}

/**
 * The same lookup for many lots in one call (bulk import), keyed by canonical
 * BBL. A lot PLUTO does not have (condo unit lots) is simply absent.
 */
export async function fetchPlutoLots(client: SocrataClient, bbls: string[]): Promise<Map<string, PlutoLot>> {
  const out = new Map<string, PlutoLot>();
  if (bbls.length === 0) return out;
  const rows = await client.get<PlutoLot>(PLUTO_DATASET, {
    $select: FIELDS,
    $where: `bbl in (${bbls.map(plutoKey).join(',')})`,
    $limit: String(bbls.length), // one row per lot
  });
  for (const row of rows) {
    try {
      if (row.bbl) out.set(normalizeBbl(row.bbl).bbl, row);
    } catch {
      /* a malformed bbl from the source: skip the row */
    }
  }
  return out;
}

/**
 * The lot's official address in the form a normalized input takes:
 * '338 5 AVENUE, MANHATTAN'. It is what a lot registered by BBL shows until
 * an address is sent for it; the typed address then takes precedence.
 */
export function plutoAddress(lot: PlutoLot | null, borough: number | null): string | null {
  const street = lot?.address?.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!street) return null;
  const name = borough === null ? undefined : BOROUGH_NAME[borough];
  return name ? `${street}, ${name}` : street;
}
