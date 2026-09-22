// BBL → the buildings (BINs) on that lot, from Building Footprints (5zhs-2jue).
// Verified 2026-09-17: for condos base_bbl is the ground lot and only
// mappluto_bbl carries the billing lot, so we query both columns.

import { soqlString, type SocrataClient } from '../socrata/fetch.js';

const FOOTPRINTS_DATASET = '5zhs-2jue';

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

/**
 * The same lookup for many lots in one call (bulk import). Each row is filed
 * under the BBL it matched; lots with no rows get an empty list, so the
 * caller can settle every lot it asked about.
 */
export async function lookupBinsForMany(client: SocrataClient, bbls: string[]): Promise<Map<string, LotBuilding[]>> {
  const result = new Map<string, LotBuilding[]>(bbls.map((b) => [b, []]));
  if (bbls.length === 0) return result;
  // Each lot appears twice in the URL (~38 chars encoded); Socrata answers
  // HTTP 414 past ~16 KB, so callers chunk to FOOTPRINTS_BATCH_SIZE (300).
  const list = bbls.map(soqlString).join(',');
  const rows = await client.get<FootprintRow>(FOOTPRINTS_DATASET, {
    $select: 'bin,base_bbl,mappluto_bbl',
    $where: `mappluto_bbl in (${list}) OR base_bbl in (${list})`,
    $limit: '50000',
  });
  for (const row of rows) {
    const bin = String(row.bin);
    // A row can belong to two of our lots (a condo's billing lot and ground lot).
    const targets: Array<[string, LotBuilding['source']]> = [
      [row.mappluto_bbl, 'mappluto_bbl'],
      [row.base_bbl, 'base_bbl'],
    ];
    for (const [bbl, source] of targets) {
      const list = result.get(bbl);
      if (!list || list.some((b) => b.bin === bin)) continue;
      list.push({ bin, source, isPlaceholder: isPlaceholderBin(bin) });
    }
  }
  for (const list of result.values()) list.sort((a, b) => a.bin.localeCompare(b.bin));
  return result;
}
