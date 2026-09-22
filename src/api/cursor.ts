// Opaque keyset cursors. A cursor is the sort key of the last row on the
// page, base64url-encoded; the next page is "rows after that key". Unlike an
// offset it does not shift when rows are inserted or removed between pages.
//
// Every field is shape-checked before it reaches SQL, so a forged or stale
// cursor is a 400, not a Postgres cast error surfacing as a 500.

import { badRequest } from './errors.js';

export type CursorField = (value: string) => boolean;

export const cursorText: CursorField = (v) => v.length > 0;
export const cursorDate: CursorField = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
export const cursorBbl: CursorField = (v) => /^\d{10}$/.test(v);
export const cursorUuid: CursorField = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** Postgres' text form of a timestamptz, e.g. 2026-09-20 12:15:59.169123+00. */
export const cursorTimestamp: CursorField = (v) =>
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.test(v);

export function encodeCursor(key: Record<string, string | null>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Decode and check every expected field: null, or a string of the declared shape. */
export function decodeCursor<K extends string>(cursor: string, fields: Record<K, CursorField>): Record<K, string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid cursor');
  }
  if (typeof parsed !== 'object' || parsed === null) throw badRequest('invalid cursor');
  const out = {} as Record<K, string | null>;
  for (const f of Object.keys(fields) as K[]) {
    const v = (parsed as Record<string, unknown>)[f];
    if (v === null) {
      out[f] = null;
      continue;
    }
    if (typeof v !== 'string' || !fields[f](v)) throw badRequest('invalid cursor');
    out[f] = v;
  }
  return out;
}
