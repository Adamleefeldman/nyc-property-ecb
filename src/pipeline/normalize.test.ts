import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ESB_ROW } from './fixtures/ecb.js';
import { normalizeViolation, parseMoney, parseYyyymmdd } from './normalize.js';

describe('parseYyyymmdd', () => {
  it('converts the compact form to ISO', () => {
    assert.equal(parseYyyymmdd('20090605'), '2009-06-05');
  });
  it('rejects impossible dates and other shapes', () => {
    for (const bad of ['20091305', '20090230', '2009-06-05', '', undefined, '0']) {
      assert.equal(parseYyyymmdd(bad), null, String(bad));
    }
  });
});

describe('parseMoney', () => {
  it('gives two decimals and keeps negatives', () => {
    assert.equal(parseMoney('500'), '500.00');
    assert.equal(parseMoney('1250.5'), '1250.50');
    assert.equal(parseMoney('-1250'), '-1250.00');
    assert.equal(parseMoney('$1,000'), '1000.00');
  });
  it('returns null for junk or blank', () => {
    for (const bad of ['', ' ', 'N/A', undefined, '12abc']) assert.equal(parseMoney(bad), null, String(bad));
  });
});

describe('normalizeViolation', () => {
  it('types the ESB row', () => {
    const n = normalizeViolation(ESB_ROW)!;
    assert.equal(n.ecb_violation_number, '38203884L');
    assert.equal(n.bin, '1015862');
    assert.equal(n.bbl, '1008350041');
    assert.deepEqual([n.borough, n.block, n.lot], [1, '00835', '0041']);
    assert.equal(n.status, 'RESOLVE');
    assert.equal(n.issue_date, '2009-06-05');
    assert.equal(n.hearing_date, '2009-07-30');
    assert.equal(n.penalty_imposed, '500.00');
    assert.equal(n.balance_due, '0.00');
    assert.equal(n.infraction_code, '251');
    assert.match(n.section_law_description!, /^28-301\.1 FAILURE TO MAINTAIN/); // runs of spaces collapsed
    assert.equal(n.content_hash.length, 32);
  });

  it('pads short block and lot and builds the canonical BBL', () => {
    const n = normalizeViolation({ ...ESB_ROW, block: '835', lot: '41' })!;
    assert.deepEqual([n.block, n.lot, n.bbl], ['00835', '0041', '1008350041']);
  });

  it('leaves the BBL null when any part is missing', () => {
    assert.equal(normalizeViolation({ ...ESB_ROW, lot: '' })!.bbl, null);
    assert.equal(normalizeViolation({ ...ESB_ROW, boro: '9' })!.bbl, null);
  });

  it('keeps a row with no BIN, with bin null', () => {
    const n = normalizeViolation({ ...ESB_ROW, bin: undefined })!;
    assert.equal(n.bin, null);
  });

  it('drops a row with no violation number', () => {
    assert.equal(normalizeViolation({ ...ESB_ROW, ecb_violation_number: ' ' }), null);
  });

  it('hash is stable for the same values and changes when a served value changes', () => {
    const a = normalizeViolation(ESB_ROW)!;
    const b = normalizeViolation({ ...ESB_ROW, ':id': 'row-different', isn_dob_bis_extract: '999' })!;
    const c = normalizeViolation({ ...ESB_ROW, balance_due: '250' })!;
    assert.equal(a.content_hash, b.content_hash); // Socrata id and unused fields do not matter
    assert.notEqual(a.content_hash, c.content_hash);
  });
});
