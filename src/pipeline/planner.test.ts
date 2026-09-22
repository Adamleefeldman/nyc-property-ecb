import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planBatches } from './planner.js';

const prop = (bbl: string, ...bins: string[]) => ({ id: `id-${bbl}`, bbl, bins });

describe('planBatches', () => {
  it('fills batches up to the size, keeping each property whole', () => {
    const batches = planBatches([prop('1', 'a', 'b'), prop('2', 'c', 'd'), prop('3', 'e')], 3);
    assert.deepEqual(
      batches.map((b) => b.bins),
      [['a', 'b'], ['c', 'd', 'e']],
    );
    assert.deepEqual(
      batches.map((b) => b.propertyIds),
      [['id-1'], ['id-2', 'id-3']],
    );
    assert.deepEqual(batches.map((b) => b.batchNo), [1, 2]);
  });

  it('is deterministic regardless of input order', () => {
    const a = planBatches([prop('2', 'y'), prop('1', 'x'), prop('3', 'z')], 2);
    const b = planBatches([prop('3', 'z'), prop('1', 'x'), prop('2', 'y')], 2);
    assert.deepEqual(a, b);
    assert.deepEqual(a[0]!.bins, ['x', 'y']);
  });

  it('skips properties with no BINs and de-duplicates a shared BIN within a batch', () => {
    const batches = planBatches([prop('1'), prop('2', 'shared', 'k'), prop('3', 'shared')], 10);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]!.bins, ['k', 'shared']);
    assert.deepEqual(batches[0]!.propertyIds, ['id-2', 'id-3']);
  });

  it('a property larger than the batch size still gets a batch of its own', () => {
    const batches = planBatches([prop('1', 'a', 'b', 'c'), prop('2', 'd')], 2);
    assert.deepEqual(batches.map((b) => b.bins), [['a', 'b', 'c'], ['d']]);
  });
});
