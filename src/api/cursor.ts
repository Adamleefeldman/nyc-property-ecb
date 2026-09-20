// Opaque keyset cursors. A cursor is the sort key of the last row on the
// page, base64url-encoded; the next page is "rows after that key". Unlike an
// offset it does not shift when rows are inserted or removed between pages.

import { badRequest } from './errors.js';

export function encodeCursor(key: Record<string, string | null>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Decode and check that every expected field is present (string or null). */
export function decodeCursor<K extends string>(cursor: string, fields: readonly K[]): Record<K, string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid cursor');
  }
  if (typeof parsed !== 'object' || parsed === null) throw badRequest('invalid cursor');
  const out = {} as Record<K, string | null>;
  for (const f of fields) {
    const v = (parsed as Record<string, unknown>)[f];
    if (v !== null && typeof v !== 'string') throw badRequest('invalid cursor');
    out[f] = v as string | null;
  }
  return out;
}
