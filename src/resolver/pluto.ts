// PLUTO (64uk-42ks): one row per lot with parcel facts. Stored as returned,
// in properties.pluto, for display and for the scale seed. Not required for
// resolution, so a miss is not an error.

import { soqlString, type SocrataClient } from '../socrata/fetch.js';

export const PLUTO_DATASET = '64uk-42ks';
const FIELDS =
  'bbl,borough,block,lot,address,zipcode,bldgclass,landuse,ownername,numbldgs,numfloors,unitsres,unitstotal,yearbuilt,cd,lotarea,bldgarea';

export type PlutoLot = Record<string, string>;

/** PLUTO stores the BBL as a decimal, e.g. 1008350041.00000000. */
export async function fetchPlutoLot(client: SocrataClient, bbl: string): Promise<PlutoLot | null> {
  const rows = await client.get<PlutoLot>(PLUTO_DATASET, {
    $select: FIELDS,
    $where: `bbl=${soqlString(`${bbl}.00000000`)}`,
    $limit: '1',
  });
  return rows[0] ?? null;
}
