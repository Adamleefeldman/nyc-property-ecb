// BBL → the buildings (BINs) on that lot, from Building Footprints (5zhs-2jue).
// Verified 2026-09-17: for condos base_bbl is the ground lot and only
// mappluto_bbl carries the billing lot, so we query both columns.

import { soqlString, type SocrataClient } from '../socrata/fetch.js';

export const FOOTPRINTS_DATASET = '5zhs-2jue';

export interface LotBuilding {
  bin: string;
  /** Which Footprints column matched the BBL we asked about. */
  source: 'mappluto_bbl' | 'base_bbl';
  /** BINs ending in 000000 are the city's "unknown building" placeholders. */
  isPlaceholder: boolean;
}

interface FootprintRow {
  bin: string;
  base_bbl: string;
  mappluto_bbl: string;
}

export function isPlaceholderBin(bin: string): boolean {
  return bin.endsWith('000000');
}

export async function lookupBins(client: SocrataClient, bbl: string): Promise<LotBuilding[]> {
  const rows = await client.get<FootprintRow>(FOOTPRINTS_DATASET, {
    $select: 'bin,base_bbl,mappluto_bbl',
    $where: `mappluto_bbl=${soqlString(bbl)} OR base_bbl=${soqlString(bbl)}`,
    $limit: '1000',
  });

  const seen = new Map<string, LotBuilding>();
  for (const row of rows) {
    const bin = String(row.bin);
    if (seen.has(bin)) continue;
    seen.set(bin, {
      bin,
      source: row.mappluto_bbl === bbl ? 'mappluto_bbl' : 'base_bbl',
      isPlaceholder: isPlaceholderBin(bin),
    });
  }
  return [...seen.values()].sort((a, b) => a.bin.localeCompare(b.bin));
}
