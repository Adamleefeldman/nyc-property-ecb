// Fetch ECB violation rows (6bgk-3dad) for a set of BINs, page by page.

import { soqlString, type SocrataClient } from '../socrata/fetch.js';
import type { RawViolation } from './normalize.js';

export const ECB_DATASET = '6bgk-3dad';

export interface EcbRow extends RawViolation {
  ':id': string;
  ':created_at'?: string;
  ':updated_at'?: string;
}

export interface FetchOptions {
  pageSize: number;
  /** Ceiling on pages for one call; a batch that exceeds it is a bug, not a bigger batch. */
  maxPages: number;
}

export class PageLimitError extends Error {
  constructor(maxPages: number, bins: number) {
    super(`ECB fetch exceeded ${maxPages} pages for ${bins} BIN(s); lower the batch size`);
    this.name = 'PageLimitError';
  }
}

export function binsWhere(bins: string[]): string {
  return `bin in (${bins.map(soqlString).join(',')})`;
}

/**
 * All rows for the BINs. Stable order (`:id`) so pages never overlap;
 * `*` must come first in `$select` or Socrata rejects the system fields.
 */
export async function fetchViolations(client: SocrataClient, bins: string[], opts: FetchOptions): Promise<EcbRow[]> {
  const rows: EcbRow[] = [];
  for (let page = 0; ; page += 1) {
    if (page >= opts.maxPages) throw new PageLimitError(opts.maxPages, bins.length);
    const chunk = await client.get<EcbRow>(ECB_DATASET, {
      $select: '*,:id,:created_at,:updated_at',
      $where: binsWhere(bins),
      $order: ':id',
      $limit: String(opts.pageSize),
      $offset: String(page * opts.pageSize),
    });
    rows.push(...chunk);
    if (chunk.length < opts.pageSize) return rows;
  }
}
