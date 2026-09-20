// Resolver behaviours that only show in the database: idempotency across
// spellings and paths, the pending state and its retry, the guards.
// Real Postgres (app_test), fake city.

import { getTestDb, SKIP_REASON } from '../test/db.js'; // first: points DATABASE_URL at app_test
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { CPW15_BILLING, ESB, VACANT } from './fixtures/footprints.js';
import { ESB as PLUTO_ESB } from './fixtures/pluto.js';
import { fakeCity } from '../test/fakes.js';

const db = await getTestDb();
const { registerByBbl, registerByAddress } = await import('./resolve.js');
const { listRetryable } = await import('./properties.js');
const { registerBulkByBbl } = await import('./bulk.js');

describe('resolver (integration)', { skip: db ? false : SKIP_REASON }, () => {
  const footprintRows = [...ESB.rows, ...CPW15_BILLING.rows];
  const pool = db!.pool;

  beforeEach(() => db!.reset());
  after(() => db!.close());

  it('three spellings of one BBL → one property, three input rows, one Footprints call', async () => {
    const city = fakeCity({ footprintRows });
    const a = await registerByBbl(pool, city, '1008350041');
    const b = await registerByBbl(pool, city, '1-00835-0041');
    const c = await registerByBbl(pool, city, '1008350041.00000000');
    assert.equal(a.httpStatus, 201);
    assert.equal(b.httpStatus, 200);
    assert.equal(c.httpStatus, 200);
    assert.equal(new Set([a.property.id, b.property.id, c.property.id]).size, 1);
    assert.deepEqual(a.property.bins, ['1015862']);
    assert.equal(a.property.resolution.status, 'resolved');
    assert.equal(city.socrata.stats().calls, 1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM property_inputs');
    assert.equal(rows[0].n, 3);
  });

  it('an address resolves to the same property as its BBL, and a repeat costs no geocoding', async () => {
    const city = fakeCity({ footprintRows, plutoRows: PLUTO_ESB });
    const byBbl = await registerByBbl(pool, city, '1008350041');
    const byAddr = await registerByAddress(pool, city, '350 5th Avenue, Manhattan');
    assert.equal(byAddr.httpStatus, 200);
    assert.equal(byAddr.property.id, byBbl.property.id);
    assert.equal(byAddr.property.normalizedAddress, '350 5 AVENUE, MANHATTAN');
    assert.equal(byAddr.property.pluto?.address, '338 5 AVENUE'); // PLUTO's one address per lot
    assert.equal(city.geosearch.stats().calls, 1);
    await registerByAddress(pool, city, '  350 5TH AVE, manhattan ');
    assert.equal(city.geosearch.stats().calls, 1); // served from property_inputs
  });

  it('rejects a street that does not exist and an address without a borough that exists in two', async () => {
    const city = fakeCity({ footprintRows });
    const wrong = await registerByAddress(pool, city, '1820 Riverside Ave, Bronx');
    assert.equal(wrong.property.resolution.status, 'unresolved');
    assert.match(wrong.property.resolution.reason!, /no exact match.*GILDERSLEEVE/);
    assert.equal(wrong.property.bbl, null);
    const ambiguous = await registerByAddress(pool, city, '350 5th Avenue');
    assert.match(ambiguous.property.resolution.reason!, /ambiguous borough/);
    assert.equal(city.socrata.stats().calls, 0); // never reached Footprints
  });

  it('GeoSearch down → 202 pending with no lot; retry resolves it and keeps the id', async () => {
    const city = fakeCity({ footprintRows, plutoRows: PLUTO_ESB });
    city.outage.geosearch = 503;
    const first = await registerByAddress(pool, city, '350 5th Avenue, Manhattan');
    assert.equal(first.httpStatus, 202);
    assert.equal(first.property.resolution.status, 'pending');
    assert.equal(first.property.bbl, null);
    assert.match(first.property.resolution.reason!, /GeoSearch unavailable: HTTP 503/);

    city.outage = {};
    const retryable = await listRetryable(pool);
    assert.equal(retryable.length, 1);
    const again = await registerByAddress(pool, city, retryable[0]!.rawInput);
    assert.equal(again.property.id, first.property.id);
    assert.equal(again.property.resolution.status, 'resolved');
    assert.equal(again.property.bbl, '1008350041');
    assert.deepEqual(again.property.bins, ['1015862']);
  });

  it('Footprints down → property stored, pending, 202; next attempt settles it', async () => {
    const city = fakeCity({ footprintRows });
    city.outage.socrata = 503;
    const first = await registerByBbl(pool, city, '1011147503');
    assert.equal(first.httpStatus, 202);
    assert.equal(first.property.resolution.status, 'pending');
    assert.equal(first.property.bbl, '1011147503');
    city.outage = {};
    const again = await registerByBbl(pool, city, '1011147503');
    assert.equal(again.property.resolution.status, 'resolved');
    assert.deepEqual(again.property.bins, ['1087510', '1087839']);
  });

  it('a condo unit lot is stored unresolved with no call; a vacant lot is not_applicable', async () => {
    const city = fakeCity({ footprintRows });
    const condo = await registerByBbl(pool, city, '1011141001');
    assert.equal(condo.property.resolution.status, 'unresolved');
    assert.match(condo.property.resolution.reason!, /condo unit lot/);
    assert.equal(city.socrata.stats().calls, 0);
    const vacant = await registerByBbl(pool, city, VACANT.bbl);
    assert.equal(vacant.property.resolution.status, 'not_applicable');
    assert.deepEqual(vacant.property.bins, []);
  });

  it('bulk: one statement for the lots, one Footprints call per 500, counts and per-item failures', async () => {
    const city = fakeCity({ footprintRows });
    await registerByBbl(pool, city, '1008350041'); // already known
    const r = await registerBulkByBbl(pool, city.socrata, ['1008350041', '1-00835-0041', '1011147503', VACANT.bbl, '1011141001', 'nope'], {
      footprintsBatchSize: 500,
    });
    assert.deepEqual(
      [r.received, r.distinct, r.created, r.existing, r.failed],
      [6, 4, 3, 1, 1],
    );
    assert.deepEqual(r.byStatus, { resolved: 2, not_applicable: 1, unresolved: 1, pending: 0 });
    assert.equal(r.footprintsCalls, 1);
    assert.equal(r.failures[0]!.bbl, 'nope');
    assert.equal(city.geosearch.stats().calls, 0);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM property_inputs');
    assert.equal(rows[0].n, 5); // every valid spelling recorded, including the duplicate one
  });
});
