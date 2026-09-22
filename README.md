# NYC Property Resolver + ECB Violations

Turns an NYC address or BBL into the city's official property IDs, keeps a
local copy of that property's DOB ECB violations refreshed on a schedule, and
serves them through our own API. The city's API (Socrata) is never called
while answering a request.

Two terms used throughout: a **BBL** is the 10-digit tax-lot ID (borough,
block, lot); a **BIN** is the 7-digit building ID that DOB records, including
ECB violations, are keyed by. One lot can hold several buildings.

- `DESIGN.md`: why it is built this way.
- `docs/verification.md`: the evidence: run logs, the 10,000-lot run, spot checks, tests.
- `docs/limitations.md`: known gaps and what we do about them.
- `docs/adding-a-dataset.md`: the recipe for the next dataset.

## Run it

Needs Docker. Nothing else.

```sh
cp .env.example .env        # optional: add a Socrata app token
docker compose up
```

That starts Postgres, the API on http://localhost:3000 and the scheduler.
Migrations run on start. Postgres is also reachable at localhost:5433 for a
SQL client. Then load the sample addresses and run the pipeline once:

```sh
docker compose run --rm api npm run seed
docker compose run --rm api npm run ingest
```

`seed/addresses.json` holds seven real addresses, each with the reason it is
there: 350 5th Avenue (the reference case), a hyphenated Queens number, a
condo unit, a property with an unpaid balance, two small two-family houses
and a Bronx public building. Running the seed twice creates nothing.

For the 10,000-lot run (Brooklyn community district 301, by BBL from PLUTO):

```sh
docker compose run --rm api npm run import -- seed/scale-10k.csv
docker compose run --rm api npm run ingest
```

Measured: import 43 s and 80 Socrata calls (40 PLUTO, 40 Footprints); run
19 Socrata calls, 37,574 rows stored, 0 failures, 44 to 72 s depending on
how fast the city answers that minute. Console output is in `runlogs/`, the
details in `docs/verification.md`.

Tests: `npm test` runs the unit tests with no database or network;
`docker compose run --rm api npm test` adds the Postgres-backed suites. No
test calls the city.

**Where the IDs come from.** NYC GeoSearch turns an address into a BBL and
BIN; it is the only free service that reads addresses, but its confidence
score is always 0.8, so we accept a result only when the house number, street
and borough match what was typed. Building Footprints turns a BBL into every
BIN on the lot; we query both its `base_bbl` and `mappluto_bbl` columns so
condo billing lots work. PLUTO adds the lot's official address and parcel
facts. Violations are joined to properties by BIN, never by block and lot,
because the ECB data pads lot numbers inconsistently and a block/lot query
silently misses rows.

**Spot check.** Both properties we checked match the city's own hearing
records (OATH) to the dollar: 350 5th Avenue has 241 violations, none unpaid;
939 2nd Avenue has 51, of which 21 are unpaid, $434,250 owed. DOB's BIS page
returned 403 from every network we had; the expected BIS values are in
`docs/verification.md`.

## Change the schedule

```
INGEST_INTERVAL=24h     # e.g. 30m, 6h, 1d; at most 24d
```

Set it in `.env` and restart. No code changes. On start the scheduler runs at
once if the last successful run is older than the interval, or there was
none, so a restart never skips a run. Every other operational setting (batch
sizes, page size, retries, pacing, timeouts) is an environment variable too;
`.env.example` lists them with their defaults.

## Run the pipeline now

```sh
docker compose run --rm api npm run ingest
```

or `POST /admin/ingest/run`. Both return the run summary. The command exits
0 on success, 3 when some batches failed (`partial`), 1 when the run failed.
A second trigger while a run is going returns 409 (exit code 2).

```json
POST /admin/ingest/run

200
{ "runId": 5, "status": "succeeded", "resumed": false, "wallMs": 49100,
  "sourceRowsUpdatedAt": "2026-09-19T16:59:06.000Z", "socrataCalls": 44,
  "batchesTotal": 18, "batchesFailed": 0, "rowsFetched": 37574, "rowsStored": 37574,
  "rowsNew": 37167, "rowsChanged": 0, "rowsAbsent": 0, "propertiesChecked": 9469 }
```

`GET /admin/ingest/runs` lists past runs in the same shape. `GET /health`
reports the database, the interval and the last successful run.

## Endpoints

JSON in and out. Errors are always `{ "error": { "code", "message" } }`.
Lists page with an opaque `cursor`: pass back `nextCursor` until it is
`null`. Pages stay stable while the pipeline writes.

### Resolve a property

`POST /properties` with `{ "address": "..." }` or `{ "bbl": "..." }`. The
same input twice returns the same record, and any spelling of the same lot
is one record.

```json
POST /properties
{ "address": "350 5th Avenue, Manhattan" }

201
{
  "id": "0e303e0f-f11e-422b-a470-891940124a3c",
  "bbl": "1008350041", "borough": 1, "block": "00835", "lot": "0041",
  "normalizedAddress": "350 5 AVENUE, MANHATTAN", "addressSource": "input",
  "bins": ["1015862"],
  "pluto": { "address": "338 5 AVENUE", "bldgclass": "O4", "unitsres": "0", "…": "…" },
  "resolution": { "status": "resolved", "source": "geosearch", "at": "2026-09-20T12:15:51.034Z" }
}
```

201 means created, 200 found, 202 stored as `pending` because a city source
was down (`resolution.reason` says why; the next `POST` or
`npm run resolve:retry` finishes it under the same id). `bins` lists usable
building IDs only. A lot registered by BBL is not geocoded; its
`normalizedAddress` is PLUTO's address for the lot (`"addressSource":
"pluto"`) until an address is sent for it.

### Get a property

```json
GET /properties/0e303e0f-f11e-422b-a470-891940124a3c

200  the same record as above; 404 if unknown
```

### Get a property's ECB violations

`GET /properties/:id/ecb-violations?open=true&unpaid=true&limit=50&cursor=…`

Served from our database only, newest first by issue date. `open=true`
keeps `ACTIVE` violations; `unpaid=true` keeps `balance_due > 0` (a negative
balance is a credit, not a debt).

```json
GET /properties/0e303e0f-f11e-422b-a470-891940124a3c/ecb-violations?limit=1

200
{
  "coverage": { "state": "checked", "checkedAt": "2026-09-20T12:20:55.282Z",
                "sourceUpdatedAt": "2026-09-19T16:59:06.000Z", "runId": 4 },
  "items": [
    { "ecbViolationNumber": "39107427M", "bin": "1015862", "bbl": "1008350041",
      "status": "RESOLVE", "issueDate": "2024-03-01", "hearingDate": "2024-05-09",
      "hearingStatus": "ADMIT/IN-VIO", "severity": "CLASS - 1", "violationType": "Elevators",
      "violationDescription": "HOIST CABLES DAMAGED. …", "respondentName": "ESRT EMPIRE STATE BUILDIN",
      "penaltyImposed": 1250, "amountPaid": 1250, "balanceDue": 0,
      "absentSinceRunId": null, "updatedAt": "2026-09-20T12:15:59.169Z", "…": "…" }
  ],
  "nextCursor": "eyJkIjoiMjAyNC0wMy0wMSIsIm4iOiIzOTEwNzQyN00ifQ"
}
```

`coverage` says whether an empty list means "none" or "unknown":

| state | meaning |
|---|---|
| `checked` | We asked the city about this property's buildings in run `runId` at `checkedAt`. `items` is the answer, even if empty. `sourceUpdatedAt` is when the city last updated the dataset. |
| `not_checked` | Registered, but no run has reached it yet, or its building lookup is still pending. `reason` says which. |
| `failed` | The last attempt errored. `failedAt` and `error` say when and why; `lastSuccessAt` when it last worked. Rows from that success are still served. |
| `not_applicable` | No usable building ID (vacant lot, placeholder BINs only, condo unit lot). `reason` says why. |

On each item, `updatedAt` is when we stored the row or its values last
changed, and `absentSinceRunId` is set when a row the city used to return has
disappeared: we keep it and flag it rather than delete it.

### Add properties in bulk

`POST /properties/bulk` with up to 10,000 BBLs. The lots go in with one
database statement, and PLUTO and Footprints are each asked about 300 lots
per call. An invalid item fails alone. `npm run import -- file.csv` does the
same from a file with a `bbl` column.

```json
POST /properties/bulk
{ "bbls": ["1008350041", "3021280001", "nope"] }

200
{ "received": 3, "distinct": 2, "created": 1, "existing": 1, "failed": 1,
  "byStatus": { "resolved": 2, "not_applicable": 0, "unresolved": 0, "pending": 0 },
  "plutoCalls": 1, "footprintsCalls": 1,
  "failures": [ { "index": 2, "bbl": "nope", "error": "invalid BBL \"nope\": …" } ],
  "failuresTruncated": false }
```

### List results across properties

Two endpoints a scanning process can read without one call per property.

`GET /ecb-violations?updatedSince=2026-09-01T00:00:00Z&limit=500` returns
every violation we stored or changed since that time, most recent first,
each with the `propertyIds` it belongs to. `updatedSince` is our clock (when
we stored or changed the row), not the city's. `open` and `unpaid` work here
too.

```json
200
{ "items": [ { "ecbViolationNumber": "39552551P", "bin": "3068046", "status": "ACTIVE",
               "issueDate": "2026-03-31", "balanceDue": 6250, "updatedAt": "2026-09-20T12:20:35.538Z",
               "propertyIds": ["bb9a58bb-2cce-4628-a1b5-26aa7d65fa66"], "…": "…" } ],
  "nextCursor": "eyJ0IjoiMjAyNi0wOS0yMCAxMjoyMDozNS41Mzg5MTcrMDAiLCJuIjoiMzk1NTI1NTFQIn0" }
```

`GET /properties?unpaid=true&limit=100` returns the properties that owe
money, with counts and totals. Without the filter, every tracked property.

```json
200
{ "items": [ { "id": "e325fba0-5d8d-4651-8029-58100ef9f61d", "bbl": "1011147503",
               "normalizedAddress": "15 CENTRAL PARK WEST, MANHATTAN", "addressSource": "input",
               "resolutionStatus": "resolved", "binCount": 2, "activeCount": 0, "unpaidCount": 1, "unpaidTotal": 2530 } ],
  "nextCursor": "eyJiIjoiMTAxMTE0NzUwMyIsImkiOiJlMzI1ZmJhMC01ZDhkLTQ2NTEtODAyOS01ODEwMGVmOWY2MWQifQ" }
```

## Secrets

`SOCRATA_APP_TOKEN` in `.env` (see `.env.example`). Optional; it lifts the
city's unauthenticated rate limit. Never committed. `/admin/*` has no
authentication, which is out of scope for this assignment.
