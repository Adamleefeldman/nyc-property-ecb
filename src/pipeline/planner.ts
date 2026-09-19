// Turn the tracked properties into batches of BINs. Deterministic (properties
// by BBL, BINs sorted), a property's BINs stay together so its coverage is
// settled by exactly one batch, and no batch exceeds the URL-length-safe size.

export interface TrackedProperty {
  id: string;
  bbl: string;
  bins: string[];
}

export interface PlannedBatch {
  batchNo: number; // 1-based
  bins: string[];
  propertyIds: string[];
}

export function planBatches(properties: TrackedProperty[], batchSize: number): PlannedBatch[] {
  if (batchSize < 1) throw new Error('batchSize must be at least 1');
  const sorted = [...properties].sort((a, b) => a.bbl.localeCompare(b.bbl));
  const batches: PlannedBatch[] = [];
  let current: PlannedBatch | null = null;

  for (const p of sorted) {
    const bins = [...new Set(p.bins)].sort();
    if (bins.length === 0) continue;
    // Start a new batch when this property would overflow the current one.
    if (!current || current.bins.length + bins.length > batchSize) {
      current = { batchNo: batches.length + 1, bins: [], propertyIds: [] };
      batches.push(current);
    }
    // Two lots can share a BIN (a condo's ground lot and billing lot); fetch it once per batch.
    for (const bin of bins) if (!current.bins.includes(bin)) current.bins.push(bin);
    current.propertyIds.push(p.id);
  }
  return batches;
}
