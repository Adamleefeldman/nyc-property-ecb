import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backoffMs, createSocrataClient, SocrataError, soqlString } from './fetch.js';

/** A fetch stand-in that records the request and answers with a canned response. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createSocrataClient', () => {
  it('builds the resource URL with encoded SoQL params', async () => {
    const f = fakeFetch(() => json([]));
    const client = createSocrataClient({ timeoutMs: 1000, fetchImpl: f.impl });
    await client.get('5zhs-2jue', { $select: 'bin', $where: "mappluto_bbl='1008350041'" });
    const url = new URL(f.calls[0]!.url);
    assert.equal(url.origin + url.pathname, 'https://data.cityofnewyork.us/resource/5zhs-2jue.json');
    assert.equal(url.searchParams.get('$select'), 'bin');
    assert.equal(url.searchParams.get('$where'), "mappluto_bbl='1008350041'");
  });

  it('sends the app token as X-App-Token only when configured', async () => {
    const f = fakeFetch(() => json([]));
    await createSocrataClient({ timeoutMs: 1000, fetchImpl: f.impl, appToken: 'abc' }).get('x', {});
    await createSocrataClient({ timeoutMs: 1000, fetchImpl: f.impl }).get('x', {});
    const headers = (i: number) => f.calls[i]!.init.headers as Record<string, string>;
    assert.equal(headers(0)['x-app-token'], 'abc');
    assert.equal(headers(1)['x-app-token'], undefined);
  });

  it('counts every call, including failed ones', async () => {
    let n = 0;
    const f = fakeFetch(() => (n++ === 0 ? json([]) : json({ error: true }, 500)));
    const client = createSocrataClient({ timeoutMs: 1000, fetchImpl: f.impl });
    await client.get('x', {});
    await assert.rejects(client.get('x', {}));
    assert.deepEqual(client.stats(), { calls: 2 });
  });

  it('marks 429 and 5xx retryable, other 4xx not', async () => {
    for (const [status, retryable] of [[429, true], [503, true], [400, false], [414, false]] as const) {
      const f = fakeFetch(() => json([], status));
      const client = createSocrataClient({ timeoutMs: 1000, fetchImpl: f.impl });
      await assert.rejects(client.get('x', {}), (err: unknown) => {
        assert.ok(err instanceof SocrataError);
        assert.equal(err.status, status);
        assert.equal(err.retryable, retryable);
        return true;
      });
    }
  });

  it('turns a timeout into a retryable SocrataError', async () => {
    const impl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const client = createSocrataClient({ timeoutMs: 20, fetchImpl: impl });
    await assert.rejects(client.get('x', {}), (err: unknown) => {
      assert.ok(err instanceof SocrataError);
      assert.match(err.message, /timeout after 20 ms/);
      assert.equal(err.retryable, true);
      return true;
    });
  });

  it('rejects a body that is not an array', async () => {
    const f = fakeFetch(() => json({ message: 'nope' }));
    const client = createSocrataClient({ timeoutMs: 1000, fetchImpl: f.impl });
    await assert.rejects(client.get('x', {}), /not a JSON array/);
  });
});

describe('retries and pacing', () => {
  function timedClient(statuses: number[], extra: Partial<Parameters<typeof createSocrataClient>[0]> = {}) {
    let i = 0;
    let clock = 0;
    const sleeps: number[] = [];
    const f = fakeFetch(() => json([], statuses[Math.min(i++, statuses.length - 1)]));
    const client = createSocrataClient({
      timeoutMs: 1000,
      fetchImpl: f.impl,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      ...extra,
    });
    return { client, sleeps, calls: f.calls };
  }

  it('retries a 503 with growing backoff, then succeeds', async () => {
    const { client, sleeps } = timedClient([503, 503, 200], { attempts: 4 });
    await client.get('x', {});
    assert.equal(client.stats().calls, 3);
    assert.deepEqual(sleeps, [500, 1000]);
  });

  it('gives up after the attempt limit and reports the last error', async () => {
    const { client } = timedClient([429], { attempts: 3 });
    await assert.rejects(client.get('x', {}), (e: unknown) => e instanceof SocrataError && e.status === 429);
    assert.equal(client.stats().calls, 3);
  });

  it('never retries a 4xx', async () => {
    const { client, sleeps } = timedClient([414, 200], { attempts: 4 });
    await assert.rejects(client.get('x', {}));
    assert.equal(client.stats().calls, 1);
    assert.deepEqual(sleeps, []);
  });

  it('keeps the minimum gap between calls', async () => {
    const { client, sleeps } = timedClient([200], { minMsBetweenCalls: 250 });
    await client.get('x', {});
    await client.get('x', {});
    await client.get('x', {});
    assert.deepEqual(sleeps, [250, 250]); // first call immediate, then paced
  });

  it('backoff is capped', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoffMs), [500, 1000, 2000, 4000, 8000, 8000]);
  });
});

describe('soqlString', () => {
  it('quotes and escapes', () => {
    assert.equal(soqlString('1008350041'), "'1008350041'");
    assert.equal(soqlString("O'NEILL"), "'O''NEILL'");
  });
});
