# NYC Property Resolver + ECB Violations

Turns an NYC address or BBL into the city's official property IDs, keeps a
local copy of that property's DOB ECB violations refreshed on a schedule, and
serves them through our own API. Socrata is never called while answering a
request.

- `DESIGN.md` — why it is built this way: strategy, tables, idempotency,
  coverage, what comes next.
- `docs/verification.md` — the evidence: run logs, the 10,000-lot run, spot
  checks against the city, the tests.
- `docs/adding-a-dataset.md` — the recipe for the next dataset.

## Run it

Needs Docker. Nothing else.

```sh
cp .env.example .env        # optional: add a Socrata app token
docker compose up
```

Starts Postgres, the API on http://localhost:3000, and the scheduler.
Migrations run on start. To load the sample addresses and run the pipeline once:

```sh
docker compose run --rm api npm run seed
docker compose run --rm api npm run ingest
```

`seed/addresses.json` holds seven real addresses, each with the reason it is
there: 350 5th Avenue (the reference case), a hyphenated Queens number, a
condo unit, one with an unpaid balance, two small 2-family houses (one with
a single violation, one with none), and a Bronx public building. The seed
goes through the same resolver as `POST /properties`; running it twice
creates nothing.

For 10,000 lots: `npm run import -- seed/scale-10k.csv` (Brooklyn CD 301
from PLUTO), then `npm run ingest`. Measured: import 22 s, run 49 s, 44
Socrata calls, 37,574 rows, 0 failures (`docs/verification.md`).

Tests: `npm test` (no database, no network) or `docker compose run --rm api
npm test` (adds the Postgres-backed suites). Nothing in a test calls the
city.

## Change the schedule

The pipeline interval is an environment variable. Default is once a day.

```
INGEST_INTERVAL=24h     # e.g. 6h, 30m
```

Change it in `.env` and restart. No code changes. Every other operational
setting is an environment variable too (batch sizes, page size, retries,
pacing, timeouts); `.env.example` lists them with their defaults.

## Run the pipeline now

Either:

```sh
docker compose run --rm api npm run ingest
```

or `POST /admin/ingest/run` (409 if a run is already going). Both return
the run's summary: wall time, Socrata calls made, rows stored, batches
failed. `GET /admin/ingest/runs` lists past runs. `GET /health` reports the
database, the interval and the last successful run.

## Endpoints

### Resolve a property

`POST /properties` with `{ "address": "..." }` or `{ "bbl": "..." }`.
Same input twice returns the same record; it never creates a duplicate.

```json
POST /properties
{ "address": "350 5th Avenue, Manhattan" }

201
{
  "id": "0e303e0f-f11e-422b-a470-891940124a3c",
  "bbl": "1008350041",
  "borough": 1, "block": "00835", "lot": "0041",
  "normalizedAddress": "350 5 AVENUE, MANHATTAN",
  "bins": ["1015862"],
  "pluto": { "address": "338 5 AVENUE", "bldgclass": "O4", "unitsres": "0", "…": "…" },
  "resolution": { "status": "resolved", "source": "geosearch", "at": "2026-09-20T12:15:51.034Z" }
}
```

201 created it, 200 found it, 202 stored it as `pending` because a city
source was down (the record has `resolution.reason`; it is retried by the
next `POST` or `npm run resolve:retry` and keeps its id). `bins` lists
usable building IDs only. `pluto` is the city's one-address-per-lot record
(the ESB lot is filed as 338 5 Avenue), kept for context; it is not the
input. Lots registered by BBL carry no `pluto` block and no
`normalizedAddress`; nothing is geocoded for them.

### Get a property

`GET /properties/:id` — the stored record, as above.

### Get a property's ECB violations

`GET /properties/:id/ecb-violations?open=true&unpaid=true&limit=50&cursor=…`

Served from our database only. Newest first (`issue_date`, then violation
number). `open=true` keeps rows with `ecb_violation_status = ACTIVE`;
`unpaid=true` keeps rows with `balance_due > 0` (strictly: about 25,000 rows
carry a negative balance, a credit, and are not "unpaid"). `cursor` is
opaque; pass back `nextCursor` until it is `null`. Pages stay stable while
the pipeline inserts rows.

Every response says how fresh the data is and whether we actually checked:

```json
{
  "coverage": {
    "state": "checked",
    "checkedAt": "2026-09-20T12:20:55.282Z",
    "sourceUpdatedAt": "2026-09-19T16:59:06.000Z",
    "runId": 4
  },
  "items": [
    { "ecbViolationNumber": "39107427M", "bin": "1015862", "bbl": "1008350041",
      "status": "RESOLVE", "issueDate": "2024-03-01", "hearingDate": "2024-05-09",
      "hearingStatus": "ADMIT/IN-VIO", "severity": "CLASS - 1", "violationType": "Elevators",
      "violationDescription": "HOIST CABLES DAMAGED. …", "respondentName": "ESRT EMPIRE STATE BUILDIN",
      "penaltyImposed": 1250, "amountPaid": 1250, "balanceDue": 0,
      "infractionCode": "151", "absentSinceRunId": null, "updatedAt": "2026-09-20T12:15:59.169Z", "…": "…" }
  ],
  "nextCursor": "eyJkIjoiMjAyNC0wMy0wMSIsIm4iOiIzOTEwNzQyN00ifQ"
}
```

`checkedAt` is when we asked the city; `sourceUpdatedAt` is when the city
last updated the dataset (its own metadata). `updatedAt` on an item is when
we stored it or its served values last changed. `absentSinceRunId` is set
when a row the city used to return has disappeared; the row stays.

`coverage.state` is one of:

| state          | meaning                                                             |
|----------------|---------------------------------------------------------------------|
| `checked`      | We looked. `items` is the answer, even if it is empty.              |
| `not_checked`  | Registered but no run has reached it yet, or its building lookup is still pending. `reason` says which. |
| `failed`       | Last attempt errored. `failedAt` and `error` say when and why; `lastSuccessAt` when it last worked. Rows from that success are still served. |
| `not_applicable` | No usable building ID (vacant lot, placeholder-only BINs, condo unit lot), so there is nothing to check. `reason` says why. |

An empty `items` with `state: checked` means "no violations". An empty
`items` with any other state means "we don't know yet".

### Add properties in bulk

`POST /properties/bulk` with `{ "bbls": ["1008350041", "…"] }` (up to 10,000).
Not a loop over the single endpoint: the lots go in with one statement and
Building Footprints is asked about 300 lots per call (the URL limit is ~16 KB;
400 lots passes, 450 is HTTP 414). Returns counts, not
records:

```json
{ "received": 104, "distinct": 102, "created": 100, "existing": 2, "failed": 2,
  "byStatus": { "resolved": 100, "not_applicable": 1, "unresolved": 1, "pending": 0 },
  "footprintsCalls": 1,
  "failures": [ { "index": 100, "bbl": "nope", "error": "invalid BBL …" } ], "failuresTruncated": false }
```

An invalid item fails alone; the rest go through. BBL items never touch
GeoSearch. `npm run import -- file.csv` does the same from a file with a
`bbl` column (or one BBL per line), in chunks of 1,000.

### List across properties

`GET /ecb-violations?updatedSince=2026-09-10T00:00:00Z&limit=500&cursor=…`
— every violation we stored or changed since a time, across all properties,
so a scanner can read everything in a few calls instead of one per property.
Most recently changed first; each item carries `propertyIds`. `open` and
`unpaid` work here too. **`updatedSince` is our clock**: when we stored the
row or its served values changed (`updatedAt` on each item), not the city's
`:updated_at`.

`GET /properties?unpaid=true&limit=100&cursor=…` — properties with any
`balance_due > 0`, with `unpaidCount`, `unpaidTotal` and `activeCount` per
property. Without the filter, every tracked property, by BBL.

```json
{ "items": [ { "id": "e325fba0-…", "bbl": "1011147503", "normalizedAddress": "15 CENTRAL PARK WEST, MANHATTAN",
               "resolutionStatus": "resolved", "bins": 2, "activeCount": 0, "unpaidCount": 1, "unpaidTotal": 2530 } ],
  "nextCursor": "eyJiIjoiMTAxMTE0NzUwMyIs…" }
```

## Known limitations

**Condo given as a unit BBL.** Condo apartments have their own paper lot
numbers (1001–6999). Violations are recorded against the *building*, whose
lot is 7501 or higher. If you send us a unit BBL with no address, none of the
three sources can get from the apartment to the building. We store the
property with `resolution.status: "unresolved"` and the reason
`"condo unit lot; send the building address or the billing-lot BBL (7501+)"`.
Sending the address instead works: GeoSearch resolves unit addresses to the
building.

**GeoSearch outages.** It is a free city service and does go down (it
returned 503 all day on 2026-09-16). An address that cannot be geocoded is
stored as `resolution.status: "pending"` with the error and returns 202. It
is retried on the next `POST` of the same address or by `npm run
resolve:retry`, and keeps its id. BBL input does not depend on GeoSearch.

**Addresses with no exact match.** GeoSearch's confidence score is a
constant 0.8 and it returns a "match" for streets that do not exist, so we
accept a candidate only when house number, street and borough all match
what was sent. Anything else is stored as `resolution.status:
"unresolved"` with the reason (`no exact match …`, `ambiguous borough …`).
Unresolved is not final: the city's address directory gains addresses and
our normaliser improves, so the same `POST` or `npm run resolve:retry`
tries again. Only `resolved` and `not_applicable` are served from the cache
without a lookup.

**Rows without a BIN.** About 4,600 ECB rows have no BIN. They cannot be
attached to any property and are not served.

**Lots with no footprint.** Building Footprints has gaps (Madison Square
Garden's lot has no row). Such a lot lands `not_applicable` with the reason
`no buildings on lot (Building Footprints)`; DESIGN.md §5 has the fallback.

**Lot-padding.** Counting ECB rows by block and lot undercounts (the same
lot appears as `0041` and `00041`); we join by BIN. The numbers are in
`docs/verification.md`.

**No authentication.** `/admin/*` triggers work and exposes the run log;
in production it would sit behind auth. Out of scope here.

## Secrets

`SOCRATA_APP_TOKEN` in `.env` (see `.env.example`). Optional; lifts the
unauthenticated rate limit. Never committed.