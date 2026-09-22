// Register many BBLs at once. Not a loop over the single path: the lots go in
// with one statement, and Building Footprints is asked about hundreds of lots
// per call instead of one. Same rules and same statuses as POST /properties.

import type pg from 'pg';
import type { SocrataClient } from '../socrata/fetch.js';
import { CONDO_UNIT_LOT_REASON, InvalidBblError, isCondoUnitLot, normalizeBbl } from './bbl.js';
import { lookupBinsForMany } from './footprints.js';
import { fetchPlutoLots } from './pluto.js';
import { markPending, storeLotBuildings, storePlutoFacts, upsertLotsBulk, type BulkLot, type ResolutionStatus } from './properties.js';

export interface BulkOptions {
  /** Lots per Footprints call; PLUTO uses the same size (its URLs are half the length). */
  footprintsBatchSize: number;
  /** Cap on the failed-item list in the response. */
  maxFailedListed?: number;
}

export interface BulkFailure {
  index: number;
  bbl: string;
  error: string;
}

export interface BulkResult {
  received: number;
  /** Distinct valid lots after normalisation (three spellings of one lot count once). */
  distinct: number;
  created: number;
  existing: number;
  failed: number;
  byStatus: Record<ResolutionStatus, number>;
  plutoCalls: number;
  footprintsCalls: number;
  failures: BulkFailure[];
  failuresTruncated: boolean;
}

/** Pure: split the request into lots to store and items that cannot be stored. */
export function partitionBbls(bbls: string[]): { lots: BulkLot[]; failures: BulkFailure[] } {
  const byBbl = new Map<string, BulkLot>();
  const failures: BulkFailure[] = [];
  bbls.forEach((raw, index) => {
    try {
      const lot = normalizeBbl(raw);
      const existing = byBbl.get(lot.bbl);
      if (existing) {
        existing.rawInputs.push(raw);
        return;
      }
      const condo = isCondoUnitLot(lot.lot);
      byBbl.set(lot.bbl, {
        lot,
        rawInputs: [raw],
        status: condo ? 'unresolved' : 'pending',
        reason: condo ? CONDO_UNIT_LOT_REASON : null,
      });
    } catch (err) {
      failures.push({ index, bbl: raw, error: err instanceof InvalidBblError ? err.message : String(err) });
    }
  });
  return { lots: [...byBbl.values()], failures };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function registerBulkByBbl(db: pg.Pool, socrata: SocrataClient, bbls: string[], opts: BulkOptions): Promise<BulkResult> {
  const { lots, failures } = partitionBbls(bbls);
  const rows = await upsertLotsBulk(db, lots);
  const idByBbl = new Map(rows.map((r) => [r.bbl, r.id]));
  const finalStatus = new Map<string, ResolutionStatus>(rows.map((r) => [r.bbl, r.resolution_status]));

  // PLUTO facts, and with them the lot's address, for lots that have none yet.
  // Display only: an outage leaves them blank and the lots are tracked all the same.
  const plutoBefore = socrata.stats().calls;
  const needPluto = rows.filter((r) => !r.has_pluto && r.resolution_status !== 'unresolved');
  for (const group of chunk(needPluto, opts.footprintsBatchSize)) {
    try {
      const found = await fetchPlutoLots(socrata, group.map((r) => r.bbl));
      await storePlutoFacts(db, [...found].map(([bbl, pluto]) => ({ bbl, pluto })));
    } catch {
      /* display only */
    }
  }
  const plutoCalls = socrata.stats().calls - plutoBefore;

  // Only lots without buildings on file need Footprints: new ones, ones still
  // pending from an earlier outage, and legacy rows resolved before BIN lookup existed.
  const needBins = rows.filter((r) => !r.has_bins && r.resolution_status !== 'unresolved' && r.resolution_status !== 'not_applicable');

  const callsBefore = socrata.stats().calls;
  for (const group of chunk(needBins, opts.footprintsBatchSize)) {
    const groupBbls = group.map((r) => r.bbl);
    try {
      const found = await lookupBinsForMany(socrata, groupBbls);
      for (const bbl of groupBbls) {
        const property = await storeLotBuildings(db, idByBbl.get(bbl)!, found.get(bbl) ?? []);
        finalStatus.set(bbl, property.resolution.status);
      }
    } catch (err) {
      // Source down: the lots are stored; they stay pending and are retried later.
      const message = `Building Footprints lookup failed: ${(err as Error).message}`;
      for (const bbl of groupBbls) {
        await markPending(db, idByBbl.get(bbl)!, message);
        finalStatus.set(bbl, 'pending');
      }
    }
  }

  const byStatus: Record<ResolutionStatus, number> = { resolved: 0, not_applicable: 0, unresolved: 0, pending: 0 };
  for (const s of finalStatus.values()) byStatus[s] += 1;
  const cap = opts.maxFailedListed ?? 100;
  return {
    received: bbls.length,
    distinct: lots.length,
    created: rows.filter((r) => r.created).length,
    existing: rows.filter((r) => !r.created).length,
    failed: failures.length,
    byStatus,
    plutoCalls,
    footprintsCalls: socrata.stats().calls - callsBefore,
    failures: failures.slice(0, cap),
    failuresTruncated: failures.length > cap,
  };
}
