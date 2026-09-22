import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cursorBbl, cursorDate, cursorText, cursorTimestamp, cursorUuid, decodeCursor, encodeCursor } from './cursor.js';
import { HttpError } from './errors.js';

const DN = { d: cursorDate, n: cursorText };
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const rejects = (cursor: string, fields: Parameters<typeof decodeCursor>[1]) =>
  assert.throws(() => decodeCursor(cursor, fields), (e: unknown) => e instanceof HttpError && e.status === 400, cursor);

describe('cursor', () => {
  it('round-trips a key, including null', () => {
    const c = encodeCursor({ d: '2025-11-18', n: '39167468N' });
    assert.deepEqual(decodeCursor(c, DN), { d: '2025-11-18', n: '39167468N' });
    assert.deepEqual(decodeCursor(encodeCursor({ d: null, n: 'X' }), DN), { d: null, n: 'X' });
  });
  it('is opaque but URL-safe', () => {
    assert.match(encodeCursor({ d: '2025-11-18', n: '39167468N' }), /^[A-Za-z0-9_-]+$/);
  });
  it('rejects garbage, wrong shapes and wrong types with a 400', () => {
    for (const bad of ['abc', '', b64('[1]'), encodeCursor({ d: '1' }), b64('{"d":1,"n":"x"}')]) rejects(bad, DN);
  });
  it('rejects a well-formed cursor whose values would not survive the SQL cast', () => {
    rejects(encodeCursor({ d: 'garbage', n: 'x' }), DN);
    rejects(encodeCursor({ t: 'garbage', n: 'x' }), { t: cursorTimestamp, n: cursorText });
    rejects(encodeCursor({ b: '1', i: 'not-a-uuid' }), { b: cursorBbl, i: cursorUuid });
    rejects(encodeCursor({ b: 'x', i: '0e303e0f-f11e-422b-a470-891940124a3c' }), { b: cursorBbl, i: cursorUuid });
  });
  it('accepts the shapes the routes actually emit', () => {
    assert.ok(cursorTimestamp('2026-09-20 12:20:28.667398+00')); // updated_at::text
    assert.ok(cursorTimestamp('2026-09-20T12:20:28.667Z'));
    assert.ok(cursorUuid('0e303e0f-f11e-422b-a470-891940124a3c'));
    assert.ok(cursorBbl('1008350041'));
    assert.ok(cursorDate('2024-03-01'));
  });
});
