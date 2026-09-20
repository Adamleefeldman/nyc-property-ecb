// The city, faked: real client code (URL building, paging, retries, error
// classification) over a fetch that answers from captured fixtures. Tests
// can flip a source into outage mode and count what was asked.

import { createGeoSearchClient, type GeoSearchClient } from '../resolver/geosearch.js';
import { normalizeAddress } from '../resolver/address.js';
import * as GEO from '../resolver/fixtures/geosearch.js';
import { createSocrataClient, type SocrataClient } from '../socrata/fetch.js';

type Row = Record<string, string | undefined>;

export interface FakeCity {
  socrata: SocrataClient;
  geosearch: GeoSearchClient;
  /** Rows the fake ECB dataset serves; mutate between runs to simulate the city changing. */
  ecbRows: Row[];
  footprintRows: Row[];
  plutoRows: Row[];
  /** While set, every request to that source fails with this HTTP status. */
  outage: { socrata?: number; geosearch?: number };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Pull the quoted values out of `col='x'`, `col in ('x','y')`, `... OR ...`. */
function quotedValues(where: string): string[] {
  return [...where.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

export function fakeCity(init: { ecbRows?: Row[]; footprintRows?: Row[]; plutoRows?: Row[]; rowsUpdatedAt?: number } = {}): FakeCity {
  const city: FakeCity = {
    ecbRows: init.ecbRows ?? [],
    footprintRows: init.footprintRows ?? [],
    plutoRows: init.plutoRows ?? [],
    outage: {},
    socrata: null as unknown as SocrataClient,
    geosearch: null as unknown as GeoSearchClient,
  };

  const socrataFetch = (async (input: string | URL | Request) => {
    if (city.outage.socrata) return json({ error: true }, city.outage.socrata);
    const url = new URL(String(input));
    const m = /^\/(resource|api\/views)\/([^/.]+)\.json$/.exec(url.pathname);
    if (!m) return json({ error: 'unknown path' }, 404);
    const dataset = m[2]!;
    if (m[1] === 'api/views') return json({ rowsUpdatedAt: init.rowsUpdatedAt ?? 1_758_000_000 });
    const where = url.searchParams.get('$where') ?? '';
    const values = new Set(quotedValues(where));
    if (dataset === '6bgk-3dad') {
      const limit = Number(url.searchParams.get('$limit') ?? 1000);
      const offset = Number(url.searchParams.get('$offset') ?? 0);
      const rows = city.ecbRows.filter((r) => values.has(r.bin ?? ''));
      rows.sort((a, b) => (a[':id'] ?? '').localeCompare(b[':id'] ?? ''));
      return json(rows.slice(offset, offset + limit));
    }
    if (dataset === '5zhs-2jue') {
      return json(city.footprintRows.filter((r) => values.has(r.mappluto_bbl ?? '') || values.has(r.base_bbl ?? '')));
    }
    if (dataset === '64uk-42ks') {
      return json(city.plutoRows.filter((r) => values.has(r.bbl ?? '')));
    }
    return json([], 200);
  }) as typeof fetch;

  // GeoSearch fixtures are keyed by the query text the resolver would send for them.
  const fixtures = [GEO.ESB, GEO.QUEENS_HYPHEN, GEO.CPW15_UNIT, GEO.WRONG_STREET, GEO.NO_BOROUGH, GEO.STREET_ONLY, GEO.AVE_939];
  const byQuery = new Map(
    fixtures.map((fx) => {
        try {
          return [normalizeAddress(fx.query).queryText, fx.features] as const;
        } catch {
          return [fx.query, fx.features] as const; // street-only fixture: never requested
        }
      }),
  );
  const geoFetch = (async (input: string | URL | Request) => {
    if (city.outage.geosearch) return json({ error: true }, city.outage.geosearch);
    const text = new URL(String(input)).searchParams.get('text') ?? '';
    const features = byQuery.get(text) ?? [];
    return json({ features: features.map((f) => ({ properties: f })) });
  }) as typeof fetch;

  const noSleep = async () => {};
  city.socrata = createSocrataClient({ timeoutMs: 1000, attempts: 2, fetchImpl: socrataFetch, sleep: noSleep });
  city.geosearch = createGeoSearchClient({ timeoutMs: 1000, attempts: 2, fetchImpl: geoFetch, sleep: noSleep });
  return city;
}
