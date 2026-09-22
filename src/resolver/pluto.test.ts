import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSocrataClient } from '../socrata/fetch.js';
import { ESB, MISSING_UNIT_LOT, QUEENS } from './fixtures/pluto.js';
import { fetchPlutoLot, fetchPlutoLots, plutoAddress } from './pluto.js';

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
  it('returns null for a lot PLUTO does not have (condo unit lots), and so does the address', async () => {
    const { client } = clientReturning(MISSING_UNIT_LOT);
    const lot = await fetchPlutoLot(client, '1011141001');
    assert.equal(lot, null);
    assert.equal(plutoAddress(lot, 1), null);
    assert.equal(plutoAddress({ address: '' }, 1), null);
  });
});

describe('fetchPlutoLots', () => {
  it('asks for every lot in one call and keys the answer by canonical BBL', async () => {
    const { client, urls } = clientReturning([...ESB, ...QUEENS]);
    const out = await fetchPlutoLots(client, ['1008350041', '4014700059', '1011141001']);
    assert.equal(client.stats().calls, 1);
    assert.equal(
      new URL(urls[0]!).searchParams.get('$where'),
      "bbl in ('1008350041.00000000','4014700059.00000000','1011141001.00000000')",
    );
    assert.deepEqual([...out.keys()].sort(), ['1008350041', '4014700059']); // the unit lot is simply absent
    assert.equal(out.get('4014700059')?.address, '37-11 82 STREET');
  });
});

describe('plutoAddress', () => {
  it('writes the lot address in the normalized-input form', () => {
    assert.equal(plutoAddress(ESB[0]!, 1), '338 5 AVENUE, MANHATTAN');
    assert.equal(plutoAddress(QUEENS[0]!, 4), '37-11 82 STREET, QUEENS');
    assert.equal(plutoAddress({ address: '  BROOKLYN   QUEENS EXPRESSWAY ' }, 3), 'BROOKLYN QUEENS EXPRESSWAY, BROOKLYN');
  });
});
