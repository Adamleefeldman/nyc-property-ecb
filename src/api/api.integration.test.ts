// The API's promises, through Fastify's inject (no port): every coverage
// state, filters that are exact, pages that never repeat or skip, and bulk
// counts. Real Postgres (app_test); the read endpoints never call the city,
// so the data is put there by the resolver and pipeline with the fake city.

import { getTestDb, SKIP_REASON } from '../test/db.js'; // first: points DATABASE_URL at app_test
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { CPW15_BILLING, ESB, VACANT } from '../resolver/fixtures/footprints.js';
import { fakeCity } from '../test/fakes.js';
import { ECB_ROWS } from '../pipeline/fixtures/ecb-rows.js';
import { QUEENS as PLUTO_QUEENS } from '../resolver/fixtures/pluto.js';

const db = await getTestDb();
const { buildApp } = await import('./app.js');
const { registerByBbl } = await import('../resolver/resolve.js');
const { runIngestion } = await import('../pipeline/ingest.js');
const { markCoverageFailed } = await import('../pipeline/store.js');

describe('API (integration)', { skip: db ? false : SKIP_REASON }, () => {
  const pool = db!.pool;
  const app = buildApp();
  const opts = { trigger: 'cli' as const, pageSize: 1000, maxPages: 5, batchSize: 600 };
  const QUEENS = { bin: '4036223', base_bbl: '4014700059', mappluto_bbl: '4014700059' };
  const footprintRows = [...ESB.rows, ...CPW15_BILLING.rows, QUEENS];
  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() };
  };

  beforeEach(() => db!.reset());
  after(async () => {
    await app.close();
    await db!.close();
  });

  it('coverage says checked-with-none, not_checked, not_applicable and failed, each with its reason', async () => {
    const city = fakeCity({ ecbRows: ECB_ROWS, footprintRows });
    const esb = (await registerByBbl(pool, city, '1008350041')).property; // BIN with no fixture rows → checked, 0
    const queens = (await registerByBbl(pool, city, '4014700059')).property;
    await runIngestion(pool, city.socrata, opts);
    const late = (await registerByBbl(pool, city, '1011147503')).property; // registered after the run
    const vacant = (await registerByBbl(pool, city, VACANT.bbl)).property;
    const run = (await pool.query('SELECT max(id)::int AS id FROM ingestion_runs')).rows[0].id;
    await markCoverageFailed(pool, queens.id, run, 'HTTP 503');

    const checked = await get(`/properties/${esb.id}/ecb-violations`);
    assert.equal(checked.body.coverage.state, 'checked');
    assert.equal(checked.body.items.length, 0); // "we looked, there are none"
    assert.equal(checked.body.coverage.runId, run);

    const notChecked = await get(`/properties/${late.id}/ecb-violations`);
    assert.equal(notChecked.body.coverage.state, 'not_checked');
    assert.match(notChecked.body.coverage.reason, /not reached/);

    const na = await get(`/properties/${vacant.id}/ecb-violations`);
    assert.equal(na.body.coverage.state, 'not_applicable');
    assert.match(na.body.coverage.reason, /no buildings on lot/);

    const failed = await get(`/properties/${queens.id}/ecb-violations`);
    assert.equal(failed.body.coverage.state, 'failed');
    assert.equal(failed.body.coverage.error, 'HTTP 503');
    assert.ok(failed.body.coverage.lastSuccessAt);
    assert.equal(failed.body.items.length, 10); // last good data still served
  });

  it('unpaid=true keeps strictly positive balances; open=true keeps ACTIVE', async () => {
    const city = fakeCity({ ecbRows: ECB_ROWS.map((r) => ({ ...r })), footprintRows });
    city.ecbRows[0]!.balance_due = '-100'; // a credit must not count as unpaid
    const cpw = (await registerByBbl(pool, city, '1011147503')).property;
    await runIngestion(pool, city.socrata, opts);
    const unpaid = await get(`/properties/${cpw.id}/ecb-violations?unpaid=true`);
    assert.ok(unpaid.body.items.length >= 1);
    assert.ok(unpaid.body.items.every((i: { balanceDue: number }) => i.balanceDue > 0));
    const all = await get(`/properties/${cpw.id}/ecb-violations?limit=100`);
    assert.ok(all.body.items.some((i: { balanceDue: number }) => i.balanceDue < 0)); // but it is still served unfiltered
    const open = await get(`/properties/${cpw.id}/ecb-violations?open=true`);
    assert.ok(open.body.items.every((i: { status: string }) => i.status === 'ACTIVE'));
  });

  it('per-property pages never repeat or skip, even when rows are inserted between pages', async () => {
    const city = fakeCity({ ecbRows: ECB_ROWS, footprintRows });
    const cpw = (await registerByBbl(pool, city, '1011147503')).property;
    await runIngestion(pool, city.socrata, opts);
    const seen: string[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      const r = await get(`/properties/${cpw.id}/ecb-violations?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.body.items.map((i: { ecbViolationNumber: string }) => i.ecbViolationNumber));
      cursor = r.body.nextCursor;
      if (page++ === 0) {
        // Rows inserted after page 1 sort above its cursor and must not shift later pages.
        await pool.query(`INSERT INTO ecb_violations_raw (ecb_violation_number, socrata_id, payload, run_id) VALUES ('NEW1','r','{}',1),('NEW2','r','{}',1)`);
        await pool.query(`INSERT INTO ecb_violations (ecb_violation_number, bin, content_hash, first_seen_run_id, last_seen_run_id, issue_date)
                          VALUES ('NEW1','1087510','x',1,1,'2099-01-01'),('NEW2','1087510','x',1,1,'2099-01-02')`);
      }
    } while (cursor);
    assert.equal(seen.length, 17);
    assert.equal(new Set(seen).size, 17);
    assert.equal(seen.filter((n) => n.startsWith('NEW')).length, 0);
    assert.equal((await get(`/properties/${cpw.id}/ecb-violations?cursor=zzz`)).status, 400);
    const forged = Buffer.from(JSON.stringify({ d: 'garbage', n: 'x' })).toString('base64url');
    assert.equal((await get(`/properties/${cpw.id}/ecb-violations?cursor=${forged}`)).status, 400); // not a 500 from the date cast
  });

  it('cross-property updatedSince returns every row written in one transaction, paged, with property ids', async () => {
    const city = fakeCity({ ecbRows: ECB_ROWS, footprintRows });
    const cpw = (await registerByBbl(pool, city, '1011147503')).property;
    await registerByBbl(pool, city, '4014700059');
    await runIngestion(pool, city.socrata, opts); // 27 rows share one updated_at to the microsecond
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await get(`/ecb-violations?updatedSince=2000-01-01T00:00:00Z&limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200);
      seen.push(...r.body.items.map((i: { ecbViolationNumber: string }) => i.ecbViolationNumber));
      if (r.body.items[0]?.bin === '1087510') assert.deepEqual(r.body.items[0].propertyIds, [cpw.id]);
      cursor = r.body.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 27);
    assert.equal(new Set(seen).size, 27);
    assert.equal((await get('/ecb-violations?updatedSince=2999-01-01T00:00:00Z')).body.items.length, 0);
    assert.equal((await get('/ecb-violations?updatedSince=yesterday')).status, 400);
    const forged = Buffer.from(JSON.stringify({ t: 'garbage', n: 'x' })).toString('base64url');
    assert.equal((await get(`/ecb-violations?cursor=${forged}`)).status, 400);
  });

  it('GET /properties?unpaid=true lists who owes, with totals', async () => {
    const city = fakeCity({ ecbRows: ECB_ROWS, footprintRows, plutoRows: PLUTO_QUEENS });
    await registerByBbl(pool, city, '1011147503'); // $2,530 unpaid
    await registerByBbl(pool, city, '4014700059'); // nothing unpaid
    await runIngestion(pool, city.socrata, opts);
    const all = await get('/properties');
    assert.equal(all.body.items.length, 2);
    const queens = all.body.items.find((i: { bbl: string }) => i.bbl === '4014700059');
    assert.deepEqual([queens.normalizedAddress, queens.addressSource], ['37-11 82 STREET, QUEENS', 'pluto']); // by BBL: PLUTO's address
    assert.equal(queens.binCount, 1);
    const unpaid = await get('/properties?unpaid=true');
    assert.equal(unpaid.body.items.length, 1);
    assert.equal(unpaid.body.items[0].bbl, '1011147503');
    assert.equal(unpaid.body.items[0].unpaidTotal, 2530);
    assert.equal(unpaid.body.items[0].unpaidCount, 1);
    const forged = Buffer.from(JSON.stringify({ b: '1', i: 'not-a-uuid' })).toString('base64url');
    assert.equal((await get(`/properties?cursor=${forged}`)).status, 400);
  });

  it('error shape is one object everywhere: 404 unknown property, 400 bad body, 400 bad id', async () => {
    const notFound = await get('/properties/00000000-0000-0000-0000-000000000000');
    assert.equal(notFound.status, 404);
    assert.deepEqual(Object.keys(notFound.body), ['error']);
    assert.deepEqual(Object.keys(notFound.body.error), ['code', 'message']);
    const both = await app.inject({ method: 'POST', url: '/properties', payload: { bbl: '1', address: 'x' } });
    assert.equal(both.statusCode, 400);
    assert.equal(both.json().error.code, 'bad_request');
    assert.equal((await get('/properties/not-a-uuid')).status, 400);
  });
});
