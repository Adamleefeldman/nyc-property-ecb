import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeCursor, encodeCursor } from './cursor.js';
import { HttpError } from './errors.js';

describe('cursor', () => {
  it('round-trips a key, including null', () => {
    const c = encodeCursor({ d: '2025-11-18', n: '39167468N' });
    assert.deepEqual(decodeCursor(c, ['d', 'n']), { d: '2025-11-18', n: '39167468N' });
    assert.deepEqual(decodeCursor(encodeCursor({ d: null, n: 'X' }), ['d', 'n']), { d: null, n: 'X' });
  });
  it('is opaque but URL-safe', () => {
    assert.match(encodeCursor({ d: '2025-11-18', n: '39167468N' }), /^[A-Za-z0-9_-]+$/);
  });
  it('rejects garbage, wrong shapes and wrong types with a 400', () => {
    for (const bad of ['abc', '', Buffer.from('[1]').toString('base64url'), encodeCursor({ d: '1' }), Buffer.from('{"d":1,"n":"x"}').toString('base64url')]) {
      assert.throws(() => decodeCursor(bad, ['d', 'n']), (e: unknown) => e instanceof HttpError && e.status === 400, bad);
    }
  });
});
