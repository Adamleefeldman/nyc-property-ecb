import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidAddressError, normalizeAddress, normalizeStreet } from './address.js';

describe('normalizeStreet', () => {
  it('writes ordinals as numbers and street types in full, like PAD', () => {
    assert.equal(normalizeStreet('5th Avenue'), '5 AVENUE');
    assert.equal(normalizeStreet('5th Ave.'), '5 AVENUE');
    assert.equal(normalizeStreet('82nd St'), '82 STREET');
    assert.equal(normalizeStreet('W 34th St'), 'WEST 34 STREET');
    assert.equal(normalizeStreet('Central Park West'), 'CENTRAL PARK WEST');
  });
  it('converts spelled-out ordinals, including compounds and hundreds', () => {
    assert.equal(normalizeStreet('Fifth Avenue'), '5 AVENUE');
    assert.equal(normalizeStreet('Second Ave'), '2 AVENUE');
    assert.equal(normalizeStreet('West Forty-Second Street'), 'WEST 42 STREET');
    assert.equal(normalizeStreet('East Forty Second St'), 'EAST 42 STREET');
    assert.equal(normalizeStreet('One Hundred Twenty-Fifth Street'), '125 STREET');
    assert.equal(normalizeStreet('Hundred and Tenth'), 'HUNDRED AND 10'); // "and" breaks the run; left alone
  });
  it('leaves ordinary words and cardinal-only runs alone', () => {
    assert.equal(normalizeStreet('Central Park West'), 'CENTRAL PARK WEST');
    assert.equal(normalizeStreet('Seven Avenue'), 'SEVEN AVENUE'); // cardinal without an ordinal ending: not a street number
    assert.equal(normalizeStreet('Fifth Avenue'), normalizeStreet('5 AVENUE'));
  });
  it('is idempotent on PAD form', () => {
    for (const s of ['5 AVENUE', '82 STREET', 'GILDERSLEEVE AVENUE']) assert.equal(normalizeStreet(s), s);
  });
});

describe('normalizeAddress', () => {
  it('produces the README form for the Empire State Building', () => {
    const a = normalizeAddress('350 5th Avenue, Manhattan');
    assert.equal(a.normalized, '350 5 AVENUE, MANHATTAN');
    assert.deepEqual([a.houseNumber, a.street, a.borough, a.unit], ['350', '5 AVENUE', 1, null]);
    assert.equal(a.inputKey, a.normalized);
  });

  it('keeps the Queens hyphen', () => {
    const a = normalizeAddress('37-15 82nd Street, Queens');
    assert.equal(a.houseNumber, '37-15');
    assert.equal(a.normalized, '37-15 82 STREET, QUEENS');
  });

  it('splits the unit off and keeps it in the input key only', () => {
    const a = normalizeAddress('15 Central Park West Apt 12B, Manhattan');
    assert.equal(a.unit, '12B');
    assert.equal(a.normalized, '15 CENTRAL PARK WEST, MANHATTAN');
    assert.equal(a.inputKey, '15 CENTRAL PARK WEST, MANHATTAN #12B');
    assert.equal(a.queryText, '15 CENTRAL PARK WEST, MANHATTAN');
    assert.equal(normalizeAddress('15 Central Park West #12B, Manhattan').unit, '12B');
    assert.equal(normalizeAddress('15 Central Park West, Unit 12B, Manhattan').unit, null); // unit after a comma is not parsed (yet)
  });

  it('reads the borough from various spellings and ignores state and zip', () => {
    assert.equal(normalizeAddress('350 5th Avenue, New York, NY 10001').borough, 1);
    assert.equal(normalizeAddress('1820 Nereid Ave, The Bronx').borough, 2);
    assert.equal(normalizeAddress('350 5th Avenue Brooklyn').borough, 3);
    assert.equal(normalizeAddress('37-15 82nd St, QN').borough, 4);
    assert.equal(normalizeAddress('10 Richmond Terrace, Staten Island, NY').borough, 5);
  });

  it('has no borough and no borough suffix when none is given', () => {
    const a = normalizeAddress('350 5th Avenue');
    assert.equal(a.borough, null);
    assert.equal(a.normalized, '350 5 AVENUE');
  });

  it('same text in different casing and spacing gives the same key', () => {
    assert.equal(normalizeAddress('  350   5TH  AVE , manhattan ').inputKey, normalizeAddress('350 5th Avenue, Manhattan').inputKey);
  });

  it('rejects street-only and empty input', () => {
    assert.throws(() => normalizeAddress('5th Avenue, Manhattan'), InvalidAddressError);
    assert.throws(() => normalizeAddress('   '), InvalidAddressError);
  });
});
