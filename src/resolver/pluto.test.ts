import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSocrataClient } from '../socrata/fetch.js';
import { ESB, MISSING_UNIT_LOT } from './fixtures/pluto.js';
import { fetchPlutoLot } from './pluto.js';

function clientReturning(rows: unknown) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
  return { client: createSocrataClient({ timeoutMs: 1000, fetchImpl }), urls };
}

describe('fetchPlutoLot', () => {
  it('queries by the decimal BBL form and returns the row', async () => {
    const { client, urls } = clientReturning(ESB);
    const lot = await fetchPlutoLot(client, '1008350041');
    assert.equal(new URL(urls[0]!).searchParams.get('$where'), "bbl='1008350041.00000000'");
    assert.equal(lot?.address, '338 5 AVENUE'); // PLUTO's one address per lot, not the one typed
    assert.equal(lot?.bldgclass, 'O4');
  });
  it('returns null for a lot PLUTO does not have (condo unit lots)', async () => {
    const { client } = clientReturning(MISSING_UNIT_LOT);
    assert.equal(await fetchPlutoLot(client, '1011141001'), null);
  });
});
