// NYC GeoSearch: typed address → candidate addresses with PAD's BBL and BIN.
// Its confidence score is a constant 0.8 and it returns a "match" for streets
// that do not exist, so every candidate is verified here against what the
// user asked for. Same shape as the Socrata client: one door out, calls counted.

import type { NormalizedAddress } from './address.js';
import { boroughFromText, normalizeStreet } from './address.js';

export interface GeoCandidate {
  label: string;
  houseNumber: string | null;
  street: string | null;
  borough: number | null;
  bbl: string | null;
  bin: string | null;
}

export interface GeoSearchClient {
  search(text: string, size?: number): Promise<GeoCandidate[]>;
  stats(): { calls: number };
}

export interface GeoSearchClientOptions {
  timeoutMs: number;
  /** Attempts per search before giving up; only retryable failures are retried. */
  attempts: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class GeoSearchError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeoSearchError';
  }
}

interface RawFeature {
  properties?: {
    label?: string;
    housenumber?: string;
    street?: string;
    borough?: string;
    addendum?: { pad?: { bbl?: string; bin?: string } };
  };
}

function toCandidate(f: RawFeature): GeoCandidate {
  const p = f.properties ?? {};
  const pad = p.addendum?.pad ?? {};
  return {
    label: p.label ?? '',
    houseNumber: p.housenumber?.toUpperCase() ?? null,
    street: p.street ? normalizeStreet(p.street) : null,
    borough: p.borough ? boroughFromText(p.borough) : null,
    bbl: pad.bbl ?? null,
    bin: pad.bin ?? null,
  };
}

export function createGeoSearchClient(opts: GeoSearchClientOptions): GeoSearchClient {
  const baseUrl = opts.baseUrl ?? 'https://geosearch.planninglabs.nyc';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let calls = 0;

  async function once(text: string, size: number): Promise<GeoCandidate[]> {
    const url = new URL('/v2/search', baseUrl);
    url.searchParams.set('text', text);
    url.searchParams.set('size', String(size));
    calls += 1;
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new GeoSearchError(timedOut ? `timeout after ${opts.timeoutMs} ms` : `network error: ${(err as Error).message}`, undefined, true);
    }
    if (!res.ok) throw new GeoSearchError(`HTTP ${res.status}`, res.status, res.status === 429 || res.status >= 500);
    const body = (await res.json()) as { features?: RawFeature[] };
    if (!Array.isArray(body.features)) throw new GeoSearchError('response has no features array', res.status, false);
    return body.features.map(toCandidate);
  }

  return {
    async search(text, size = 5) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await once(text, size);
        } catch (err) {
          const retry = err instanceof GeoSearchError && err.retryable && attempt < opts.attempts;
          if (!retry) throw err;
          await sleep(300 * attempt);
        }
      }
    },
    stats: () => ({ calls }),
  };
}

export type AddressMatch =
  | { kind: 'match'; bbl: string; bin: string | null; candidate: GeoCandidate }
  | { kind: 'unresolved'; reason: string };

/**
 * Ask GeoSearch, then keep only candidates whose house number and street are
 * exactly what was typed (and whose borough matches the hint, if any).
 * Throws GeoSearchError when the service is unavailable.
 */
export async function resolveAddress(client: GeoSearchClient, address: NormalizedAddress): Promise<AddressMatch> {
  const candidates = await client.search(address.queryText, 5);
  const exact = candidates.filter(
    (c) =>
      c.bbl !== null &&
      c.houseNumber === address.houseNumber &&
      c.street === address.street &&
      (address.borough === null || c.borough === address.borough),
  );
  if (exact.length === 0) {
    const nearest = candidates[0]?.label;
    return {
      kind: 'unresolved',
      reason: `no exact match for "${address.normalized}"` + (nearest ? ` (nearest: ${nearest})` : ''),
    };
  }
  const boroughs = new Set(exact.map((c) => c.borough));
  if (address.borough === null && boroughs.size > 1) {
    return { kind: 'unresolved', reason: `ambiguous borough: "${address.normalized}" exists in ${boroughs.size} boroughs; add the borough` };
  }
  const best = exact[0]!;
  return { kind: 'match', bbl: best.bbl!, bin: best.bin, candidate: best };
}
