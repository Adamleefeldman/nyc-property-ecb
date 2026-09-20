import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunk, partitionBbls } from './bulk.js';

describe('partitionBbls', () => {
  it('normalises, de-duplicates spellings of one lot, keeps every raw input, and isolates bad items', () => {
    const { lots, failures } = partitionBbls(['1008350041', '1-00835-0041', 'nope', '1011141001', '1008350041.00000000', '9999999999']);
    assert.deepEqual(
      lots.map((l) => [l.lot.bbl, l.rawInputs.length, l.status]),
      [
        ['1008350041', 3, 'pending'],
        ['1011141001', 1, 'unresolved'], // condo unit lot: stored, never looked up
      ],
    );
    assert.deepEqual(failures.map((f) => f.index), [2, 5]);
    assert.match(failures[0]!.error, /invalid BBL "nope"/);
    assert.match(failures[1]!.error, /borough must be 1–5/);
  });
  it('handles an empty request', () => {
    assert.deepEqual(partitionBbls([]), { lots: [], failures: [] });
  });
});

describe('chunk', () => {
  it('splits into groups of at most size', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 3), []);
  });
});
