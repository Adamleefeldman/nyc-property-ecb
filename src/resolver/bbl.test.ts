import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidBblError, isCondoUnitLot, normalizeBbl } from './bbl.js';

const esb = { bbl: '1008350041', borough: 1, block: '00835', lot: '0041' };

describe('normalizeBbl', () => {
  it('accepts the plain 10-digit form', () => {
    assert.deepEqual(normalizeBbl('1008350041'), esb);
  });

  it('accepts the dashed form and pads block and lot', () => {
    assert.deepEqual(normalizeBbl('1-00835-0041'), esb);
    assert.deepEqual(normalizeBbl('1-835-41'), esb);
    assert.deepEqual(normalizeBbl('1/835/41'), esb);
  });

  it("accepts PLUTO's decimal form", () => {
    assert.deepEqual(normalizeBbl('1008350041.00000000'), esb);
  });

  it('ignores surrounding whitespace', () => {
    assert.deepEqual(normalizeBbl('  1008350041 \n'), esb);
  });

  it('rejects boroughs outside 1–5', () => {
    assert.throws(() => normalizeBbl('6008350041'), InvalidBblError);
    assert.throws(() => normalizeBbl('0-00835-0041'), InvalidBblError);
  });

  it('rejects wrong lengths, letters and zero block or lot', () => {
    for (const bad of ['', '100835004', '10083500411', '1O08350041', '1000000041', '1008350000']) {
      assert.throws(() => normalizeBbl(bad), InvalidBblError, bad);
    }
  });
});

describe('isCondoUnitLot', () => {
  it('flags unit lots 1001–6999 only', () => {
    assert.equal(isCondoUnitLot('1001'), true);
    assert.equal(isCondoUnitLot('6999'), true);
    assert.equal(isCondoUnitLot('0041'), false);
    assert.equal(isCondoUnitLot('1000'), false);
    assert.equal(isCondoUnitLot('7501'), false); // billing lot: resolvable
  });
});
