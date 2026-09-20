// The three pipeline promises: same input twice changes nothing; a changed
// value is updated in place and only that row's updated_at moves; a row the
// city drops is flagged, not deleted. Plus partial failure and resume.
// Real Postgres (app_test), fake city.

import { getTestDb, SKIP_REASON } from '../test/db.js'; // first: points DATABASE_URL at app_test
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { CPW15_BILLING } from '../resolver/fixtures/footprints.js';
import { fakeCity, type FakeCity } from '../test/fakes.js';
import { ECB_ROWS } from './fixtures/ecb-rows.js';

const db = await getTestDb();
const { runIngestion } = await import('./ingest.js');
const { registerByBbl } = await import('../resolver/resolve.js');

describe('ingestion (integration)', { skip: db ? false : SKIP_REASON }, () => {
  const pool = db!.pool;
  const opts = { trigger: 'cli' as const, pageSize: 1000, maxPages: 5, batchSize: 600 };
  const QUEENS = { bin: '4036223', base_bbl: '4014700059', mappluto_bbl: '4014700059' };
  let city: FakeCity;

  beforeEach(async () => {
    await db!.reset();
    city = fakeCity({ ecbRows: ECB_ROWS.map((r) => ({ ...r })), footprintRows: [...CPW15_BILLING.rows, QUEENS] });
    await registerByBbl(pool, city, '4014700059'); // 10 rows
    await registerByBbl(pool, city, '1011147503'); // 17 rows, one unpaid
  });
  after(() => db!.close());

  const count = async (sql: string) => (await pool.query(sql)).rows[0].n as number;

  it('the same rows twice → identical counts, nothing new, coverage checked', async () => {
    const first = await runIngestion(pool, city.socrata, opts);
    assert.equal(first.status, 'succeeded');
    assert.deepEqual([first.rowsFetched, first.rowsStored, first.rowsNew, first.rowsChanged], [27, 27, 27, 0]);
    assert.equal(first.propertiesChecked, 2);
    const second = await runIngestion(pool, city.socrata, opts);
    assert.deepEqual([second.rowsFetched, second.rowsStored, second.rowsNew, second.rowsChanged], [27, 27, 0, 0]);
    assert.equal(await count('SELECT count(*)::int AS n FROM ecb_violations'), 27);
    assert.equal(await count(`SELECT count(*)::int AS n FROM property_coverage WHERE state = 'checked'`), 2);
    const { rows } = await pool.query(`SELECT row_count FROM property_coverage c JOIN properties p ON p.id = c.property_id WHERE p.bbl = '4014700059'`);
    assert.equal(rows[0].row_count, 10);
  });

  it('a changed balance updates in place and moves only that row’s updated_at', async () => {
    await runIngestion(pool, city.socrata, opts);
    const target = city.ecbRows.find((r) => r.bin === '4036223')!;
    const before = await pool.query('SELECT ecb_violation_number, balance_due, updated_at FROM ecb_violations ORDER BY 1');
    target.balance_due = '999.5';
    await new Promise((r) => setTimeout(r, 5));
    const run = await runIngestion(pool, city.socrata, opts);
    assert.deepEqual([run.rowsNew, run.rowsChanged], [0, 1]);
    const after_ = await pool.query('SELECT ecb_violation_number, balance_due, updated_at FROM ecb_violations ORDER BY 1');
    for (let i = 0; i < before.rows.length; i += 1) {
      const b = before.rows[i];
      const a = after_.rows[i];
      if (a.ecb_violation_number === target.ecb_violation_number) {
        assert.equal(a.balance_due, '999.50');
        assert.ok(a.updated_at > b.updated_at, 'changed row moved');
      } else {
        assert.equal(a.updated_at.getTime(), b.updated_at.getTime(), `untouched row ${a.ecb_violation_number} did not move`);
      }
    }
    assert.equal(await count('SELECT count(*)::int AS n FROM ecb_violations'), 27); // in place, not appended
  });

  it('a row the city stops returning is flagged absent, kept, and un-flagged if it returns', async () => {
    await runIngestion(pool, city.socrata, opts);
    const dropped = city.ecbRows.splice(0, 1)[0]!;
    const run = await runIngestion(pool, city.socrata, opts);
    assert.equal(run.rowsAbsent, 1);
    const { rows } = await pool.query('SELECT absent_since_run_id FROM ecb_violations WHERE ecb_violation_number = $1', [dropped.ecb_violation_number]);
    assert.equal(Number(rows[0].absent_since_run_id), run.runId);
    assert.equal(await count('SELECT count(*)::int AS n FROM ecb_violations'), 27); // kept
    city.ecbRows.push(dropped);
    await runIngestion(pool, city.socrata, opts);
    const back = await pool.query('SELECT absent_since_run_id FROM ecb_violations WHERE ecb_violation_number = $1', [dropped.ecb_violation_number]);
    assert.equal(back.rows[0].absent_since_run_id, null);
  });

  it('a failing batch → run partial, its properties failed with last success kept, the others checked', async () => {
    await runIngestion(pool, city.socrata, opts);
    const run = await runIngestion(pool, city.socrata, { ...opts, batchSize: 2, failBatch: 1 });
    assert.equal(run.status, 'partial');
    assert.deepEqual([run.batchesTotal, run.batchesFailed], [2, 1]);
    const { rows } = await pool.query(
      `SELECT p.bbl, c.state, c.error, c.last_success_at IS NOT NULL AS had_success FROM property_coverage c JOIN properties p ON p.id = c.property_id ORDER BY p.bbl`,
    );
    assert.deepEqual(
      rows.map((r) => [r.bbl, r.state, r.had_success]),
      [
        ['1011147503', 'failed', true],
        ['4014700059', 'checked', true],
      ],
    );
    assert.match(rows[0].error, /INGEST_FAIL_BATCH=1/);
    const healed = await runIngestion(pool, city.socrata, opts);
    assert.equal(healed.status, 'succeeded');
    assert.equal(await count(`SELECT count(*)::int AS n FROM property_coverage WHERE state = 'failed'`), 0);
  });

  it('a run that dies after a batch is resumed by the next run, which never refetches done batches', async () => {
    class Died extends Error {}
    await assert.rejects(
      runIngestion(pool, city.socrata, {
        ...opts,
        batchSize: 2,
        afterBatch: (n) => {
          if (n === 1) throw new Died('process died');
        },
      }),
      Died,
    );
    const left = await pool.query(`SELECT id, status FROM ingestion_runs ORDER BY id DESC LIMIT 1`);
    assert.equal(left.rows[0].status, 'running');
    assert.equal(await count(`SELECT count(*)::int AS n FROM ingestion_batches WHERE status = 'pending'`), 1);
    const callsBefore = city.socrata.stats().calls;
    const resumed = await runIngestion(pool, city.socrata, { ...opts, batchSize: 2 });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.runId, Number(left.rows[0].id));
    assert.equal(resumed.status, 'succeeded');
    assert.equal(city.socrata.stats().calls - callsBefore, 1); // only the pending batch
    assert.deepEqual([resumed.rowsFetched, resumed.propertiesChecked, resumed.socrataCalls], [27, 2, 3]); // 1 metadata + 2 batches across both processes
  });
});
