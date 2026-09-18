import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeAddress } from './address.js';
import { AVE_939, CPW15_UNIT, ESB, NO_BOROUGH, QUEENS_HYPHEN, STREET_ONLY, WRONG_STREET } from './fixtures/geosearch.js';
import { createGeoSearchClient, GeoSearchError, resolveAddress } from './geosearch.js';

function clientWith(responses: Array<{ status: number; features?: unknown[] } | 'timeout'>) {
  let i = 0;
  const urls: string[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r === 'timeout') return new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)));
    return Promise.resolve(new Response(JSON.stringify({ features: (r.features ?? []).map((f) => ({ properties: f })) }), { status: r.status }));
  }) as typeof fetch;
  const client = createGeoSearchClient({ timeoutMs: 20, attempts: 2, fetchImpl, sleep: async () => {} });
  return { client, urls };
}
const ok = (fx: { features: unknown[] }) => clientWith([{ status: 200, features: fx.features }]);

describe('resolveAddress', () => {
  it('accepts the exact house number + street + borough and returns PAD bbl and bin', async () => {
    const r = await resolveAddress(ok(ESB).client, normalizeAddress(ESB.query));
    assert.equal(r.kind, 'match');
    if (r.kind === 'match') assert.deepEqual([r.bbl, r.bin], ['1008350041', '1015862']);
  });

  it('keeps the Queens hyphen and matches 37-15, not 37-37 or 37', async () => {
    const r = await resolveAddress(ok(QUEENS_HYPHEN).client, normalizeAddress(QUEENS_HYPHEN.query));
    assert.equal(r.kind, 'match');
    if (r.kind === 'match') assert.deepEqual([r.bbl, r.bin], ['4014700059', '4036223']);
  });

  it('resolves a condo unit address to the billing lot', async () => {
    const r = await resolveAddress(ok(CPW15_UNIT).client, normalizeAddress(CPW15_UNIT.query));
    assert.equal(r.kind, 'match');
    if (r.kind === 'match') assert.deepEqual([r.bbl, r.bin], ['1011147503', '1087839']);
  });

  it('rejects a street that does not exist instead of taking the fallback', async () => {
    const r = await resolveAddress(ok(WRONG_STREET).client, normalizeAddress(WRONG_STREET.query));
    assert.equal(r.kind, 'unresolved');
    if (r.kind === 'unresolved') assert.match(r.reason, /no exact match.*GILDERSLEEVE/);
  });

  it('rejects an address that exists in two boroughs when no borough is given', async () => {
    const r = await resolveAddress(ok(NO_BOROUGH).client, normalizeAddress(NO_BOROUGH.query));
    assert.equal(r.kind, 'unresolved');
    if (r.kind === 'unresolved') assert.match(r.reason, /ambiguous borough/);
  });

  it('with the borough given, ignores the other-borough twin and the 350A/350B neighbours', async () => {
    const r = await resolveAddress(ok(ESB).client, normalizeAddress('350 5th Avenue, Manhattan'));
    if (r.kind === 'match') assert.equal(r.candidate.houseNumber, '350');
    const r2 = await resolveAddress(ok(NO_BOROUGH).client, normalizeAddress('350 5th Avenue, Brooklyn'));
    assert.equal(r2.kind, 'match');
    if (r2.kind === 'match') assert.equal(r2.bbl, '3009810111');
  });

  it('does not match a placeholder-free 939 2nd Avenue to the wrong row', async () => {
    const r = await resolveAddress(ok(AVE_939).client, normalizeAddress(AVE_939.query));
    if (r.kind === 'match') assert.deepEqual([r.bbl, r.bin], ['1013230128', '1038249']);
  });

  it('street-only input never reaches GeoSearch (the normalizer rejects it)', () => {
    assert.throws(() => normalizeAddress(STREET_ONLY.query));
  });
});

describe('createGeoSearchClient', () => {
  it('sends text and size, counts calls', async () => {
    const { client, urls } = ok(ESB);
    await client.search('350 5 AVENUE, MANHATTAN');
    const u = new URL(urls[0]!);
    assert.equal(u.pathname, '/v2/search');
    assert.equal(u.searchParams.get('text'), '350 5 AVENUE, MANHATTAN');
    assert.equal(u.searchParams.get('size'), '5');
    assert.equal(client.stats().calls, 1);
  });

  it('retries once on 503 then succeeds', async () => {
    const { client } = clientWith([{ status: 503 }, { status: 200, features: ESB.features }]);
    assert.equal((await client.search('x')).length, 5);
    assert.equal(client.stats().calls, 2);
  });

  it('gives up after the attempt limit with a retryable error', async () => {
    const { client } = clientWith([{ status: 503 }]);
    await assert.rejects(client.search('x'), (e: unknown) => e instanceof GeoSearchError && e.retryable && e.status === 503);
    assert.equal(client.stats().calls, 2);
  });

  it('treats a timeout as retryable', async () => {
    const { client } = clientWith(['timeout']);
    await assert.rejects(client.search('x'), (e: unknown) => e instanceof GeoSearchError && e.retryable && /timeout/.test(e.message));
  });

  it('does not retry a 4xx', async () => {
    const { client } = clientWith([{ status: 400 }]);
    await assert.rejects(client.search('x'), (e: unknown) => e instanceof GeoSearchError && !e.retryable);
    assert.equal(client.stats().calls, 1);
  });
});
