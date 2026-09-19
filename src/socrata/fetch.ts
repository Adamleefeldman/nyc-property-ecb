// The one place the app talks to NYC Open Data (Socrata). Builds the URL, adds
// the app token, applies a timeout, counts every call. The resolver and the
// pipeline both go through here, so the run log's "Socrata calls" is honest.

export interface SocrataClient {
  get<T = Record<string, string>>(dataset: string, params: Record<string, string>): Promise<T[]>;
  /** The dataset's own last-update time, from /api/views/<id>.json (rowsUpdatedAt). */
  getRowsUpdatedAt(dataset: string): Promise<Date | null>;
  stats(): { calls: number };
  resetStats(): void;
}

export interface SocrataClientOptions {
  appToken?: string | undefined;
  timeoutMs: number;
  /** Attempts per request; 429, 5xx and timeouts are retried with backoff, 4xx never. Default 1. */
  attempts?: number;
  /** Minimum gap between two calls, so a batch run is polite to a free API. Default 0. */
  minMsBetweenCalls?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch; // injected by tests; defaults to global fetch
  sleep?: (ms: number) => Promise<void>; // injected by tests
  now?: () => number;
}

/** 500 ms, 1 s, 2 s, … capped at 8 s. */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}

export class SocrataError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status: number | undefined,
    /** true for timeouts, 429 and 5xx: worth retrying. 4xx is our bug, not theirs. */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SocrataError';
  }
}

/** Quote a string for a SoQL `$where`, escaping embedded single quotes. */
export function soqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function createSocrataClient(opts: SocrataClientOptions): SocrataClient {
  const baseUrl = opts.baseUrl ?? 'https://data.cityofnewyork.us';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const attempts = opts.attempts ?? 1;
  const minGap = opts.minMsBetweenCalls ?? 0;
  let calls = 0;
  let lastCallAt = -Infinity;

  /** Every attempt is a call: pace it, count it, and retry only what is worth retrying. */
  async function request(href: string): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const wait = lastCallAt + minGap - now();
      if (wait > 0) await sleep(wait);
      lastCallAt = now();
      try {
        return await requestOnce(href);
      } catch (err) {
        const retry = err instanceof SocrataError && err.retryable && attempt < attempts;
        if (!retry) throw err;
        await sleep(backoffMs(attempt));
      }
    }
  }

  async function requestOnce(href: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.appToken) headers['x-app-token'] = opts.appToken;

    calls += 1;
    let res: Response;
    try {
      res = await fetchImpl(href, { headers, signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new SocrataError(
        timedOut ? `timeout after ${opts.timeoutMs} ms` : `network error: ${(err as Error).message}`,
        href,
        undefined,
        true,
      );
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new SocrataError(`HTTP ${res.status}`, href, res.status, retryable);
    }
    return res.json();
  }

  return {
    async get<T>(dataset: string, params: Record<string, string>): Promise<T[]> {
      const url = new URL(`/resource/${dataset}.json`, baseUrl);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const body = await request(url.toString());
      if (!Array.isArray(body)) {
        throw new SocrataError('response is not a JSON array', url.toString(), undefined, false);
      }
      return body as T[];
    },
    async getRowsUpdatedAt(dataset: string): Promise<Date | null> {
      const body = (await request(new URL(`/api/views/${dataset}.json`, baseUrl).toString())) as {
        rowsUpdatedAt?: number;
      };
      return typeof body.rowsUpdatedAt === 'number' ? new Date(body.rowsUpdatedAt * 1000) : null;
    },
    stats: () => ({ calls }),
    resetStats: () => {
      calls = 0;
    },
  };
}
