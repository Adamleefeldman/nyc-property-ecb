import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSocrataClient } from '../socrata/fetch.js';
import { CPW15_BILLING, ESB, PLACEHOLDER_ONLY, VACANT } from './fixtures/footprints.js';
import { isPlaceholderBin, lookupBins } from './footprints.js';

/** A client whose fetch answers with a captured Footprints response. */
function clientReturning(rows: unknown) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
  return { client: createSocrataClient({ timeoutMs: 1000, fetchImpl }), urls };
}

describe('lookupBins', () => {
  it('asks Footprints for both BBL columns', async () => {
    const { client, urls } = clientReturning(ESB.rows);
    await lookupBins(client, ESB.bbl);
    const where = new URL(urls[0]!).searchParams.get('$where');
    assert.equal(where, "mappluto_bbl='1008350041' OR base_bbl='1008350041'");
  });

  it('returns the one BIN on an ordinary lot', async () => {
    const { client } = clientReturning(ESB.rows);
    assert.deepEqual(await lookupBins(client, ESB.bbl), [
      { bin: '1015862', source: 'mappluto_bbl', isPlaceholder: false },
    ]);
  });

  it('returns every building on a condo billing lot, matched via mappluto_bbl', async () => {
    const { client } = clientReturning(CPW15_BILLING.rows);
    assert.deepEqual(await lookupBins(client, CPW15_BILLING.bbl), [
      { bin: '1087510', source: 'mappluto_bbl', isPlaceholder: false },
      { bin: '1087839', source: 'mappluto_bbl', isPlaceholder: false },
    ]);
  });

  it('returns nothing for a vacant lot', async () => {
    const { client } = clientReturning(VACANT.rows);
    assert.deepEqual(await lookupBins(client, VACANT.bbl), []);
  });

  it('flags placeholder BINs', async () => {
    const { client } = clientReturning(PLACEHOLDER_ONLY.rows);
    assert.deepEqual(await lookupBins(client, PLACEHOLDER_ONLY.bbl), [
      { bin: '2000000', source: 'mappluto_bbl', isPlaceholder: true },
    ]);
  });

  it('de-duplicates a BIN that appears in more than one row', async () => {
    const { client } = clientReturning([...ESB.rows, ...ESB.rows]);
    assert.equal((await lookupBins(client, ESB.bbl)).length, 1);
  });
});

describe('isPlaceholderBin', () => {
  it('matches only the six-zero suffix', () => {
    assert.equal(isPlaceholderBin('2000000'), true);
    assert.equal(isPlaceholderBin('1015862'), false);
    assert.equal(isPlaceholderBin('1000001'), false);
  });
});
