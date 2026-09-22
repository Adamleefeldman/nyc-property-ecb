import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSocrataClient } from '../socrata/fetch.js';
import { fetchViolations, PageLimitError } from './ecb-source.js';

/** A client whose fetch serves `pages` in order and records each request URL. */
function pagedClient(pages: unknown[][]) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const body = pages[urls.length - 1] ?? [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { client: createSocrataClient({ timeoutMs: 1000, fetchImpl }), urls };
}

const row = (id: number) => ({ ecb_violation_number: `V${id}`, ':id': `row-${id}` });

describe('fetchViolations', () => {
  it('sends the required select, order and paging params', async () => {
    const { client, urls } = pagedClient([[row(1)]]);
    await fetchViolations(client, ['1015862'], { pageSize: 1000, maxPages: 5 });
    const p = urls[0]!.searchParams;
    assert.equal(p.get('$select'), '*,:id,:created_at,:updated_at');
    assert.equal(p.get('$where'), "bin in ('1015862')");
    assert.equal(p.get('$order'), ':id');
    assert.equal(p.get('$limit'), '1000');
    assert.equal(p.get('$offset'), '0');
  });

  it('keeps paging until a short page, advancing the offset', async () => {
    const { client, urls } = pagedClient([[row(1), row(2)], [row(3), row(4)], [row(5)]]);
    const rows = await fetchViolations(client, ['1015862'], { pageSize: 2, maxPages: 10 });
    assert.deepEqual(
      rows.map((r) => r.ecb_violation_number),
      ['V1', 'V2', 'V3', 'V4', 'V5'],
    );
    assert.deepEqual(
      urls.map((u) => u.searchParams.get('$offset')),
      ['0', '2', '4'],
    );
    assert.equal(client.stats().calls, 3);
  });

  it('stops with an error at the page ceiling instead of looping', async () => {
    const full = Array.from({ length: 2 }, (_, i) => row(i));
    const { client } = pagedClient([full, full, full, full]);
    await assert.rejects(fetchViolations(client, ['1'], { pageSize: 2, maxPages: 3 }), PageLimitError);
    assert.equal(client.stats().calls, 3);
  });
});
