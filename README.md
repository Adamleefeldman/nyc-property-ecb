# NYC Property Resolver + ECB Violations

Turns an NYC address or BBL into the city's official property IDs, keeps a
local copy of that property's DOB ECB violations refreshed on a schedule, and
serves them through our own API. Socrata is never called while answering a
request.

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
a single violation, one with none, so `checked` with an empty list is
demonstrable), and a Bronx public building. The seed goes through the same
resolver as `POST /properties`; running it twice creates nothing.

## Scale run: 10,000 lots

`seed/scale-10k.csv` is the first 10,000 lots of Brooklyn community district
301 (Williamsburg/Greenpoint), by BBL, pulled from PLUTO with `npm run
seed:pluto` (the script is the provenance). Load and run:

```sh
docker compose run --rm api npm run import -- seed/scale-10k.csv
docker compose run --rm api npm run ingest
```

Measured on 2026-09-20 (`runlogs/scale-10k.txt`): the import resolved
10,000 lots in 22.5 s with 40 Building Footprints calls (9,462 with
buildings, 521 vacant or placeholder-only, 17 condo unit lots); the run
fetched 37,574 violations for 10,742 BINs in 49 s with 44 Socrata calls in
18 batches, 0 failed. A second run over the same lots stores 0 new rows.
`runlogs/kill-resume.txt` shows the same run killed after batch 5 and
finished by the next start.

## Change the schedule

The pipeline interval is an environment variable. Default is once a day.

```
INGEST_INTERVAL=24h     # e.g. 6h, 30m
```

Change it in `.env` and restart. No code changes.

## Run the pipeline now

Either:

```sh
docker compose run --rm api npm run ingest
```

or `POST /admin/ingest/run`. Both return the run's summary: wall time,
Socrata calls made, rows stored, batches failed.

## Endpoints

### Resolve a property

`POST /properties` with `{ "address": "..." }` or `{ "bbl": "..." }`.
Same input twice returns the same record; it never creates a duplicate.

```json
POST /properties
{ "address": "350 5th Avenue, Manhattan" }

201
{
  "id": "…",
  "bbl": "1008350041",
  "borough": 1, "block": "00835", "lot": "0041",
  "normalizedAddress": "350 5 AVENUE, MANHATTAN",
  "bins": ["1015862"],
  "resolution": { "status": "resolved", "source": "geosearch", "at": "2026-09-17T14:02:11Z" }
}
```

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
    "checkedAt": "2026-09-17T03:00:04Z",
    "sourceUpdatedAt": "2026-09-16T17:00:00Z",
    "runId": 42
  },
  "items": [ { "ecbViolationNumber": "…", "issueDate": "2024-03-01", "status": "ACTIVE", "balanceDue": 1250.00, "…": "…" } ],
  "nextCursor": "…"
}
```

`coverage.state` is one of:

| state          | meaning                                                             |
|----------------|---------------------------------------------------------------------|
| `checked`      | We looked. `items` is the answer, even if it is empty.              |
| `not_checked`  | Property is registered but the pipeline has not reached it yet.     |
| `failed`       | Last attempt errored. `failedAt` and `error` say when and why.      |
| `not_applicable` | Property has no usable building ID, so there is nothing to check. `reason` says why. |

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

## Run logs

`runlogs/` is untouched console output: `baseline.txt` (seed, first run),
`second-run.txt` (same commands again: 0 new, 0 changed), `scale-10k.txt`
(the import and the 10,000-lot run), `kill-resume.txt` (a run killed after
batch 5, resumed by the next start). The first import in `scale-10k.txt`
failed with HTTP 414 on every Footprints call and left 9,983 lots `pending`;
that is what led to the 300-lot default, and the re-run that settled them is
in the same file.

## Tests

```sh
npm test                          # unit tests: no database, no network
docker compose run --rm api npm test   # adds the database-backed suites
```

Nothing ever calls the city from a test: GeoSearch and Socrata are replaced
by fakes that serve captured responses (`src/*/fixtures/`) and can be
switched into outage mode. The unit tests cover normalisation, the clients
(retries, backoff, pacing, the 414 guard), the batch planner and cursors.
The `*.integration.test.ts` suites run against a real Postgres, one
throwaway database per file (`app_test_*`, never `app`), and prove the
behaviours that only show in the database: the same lot in any spelling or
by address is one record; a source outage leaves a `pending` row that a
retry settles under the same id; the same rows ingested twice change
nothing; a changed balance moves only that row's `updatedAt`; a row the
city drops is flagged, not deleted; a failing batch makes the run `partial`
and only its properties `failed`; a run that dies mid-way is resumed by the
next one; every coverage state through the API; pages that never repeat or
skip while rows are being inserted. Without a reachable Postgres those
suites skip with a message rather than fail.

## Where the IDs come from

| Step                    | Source                         | Why                                                                                                                                                                       |
|-------------------------|--------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| address → BBL + BIN     | NYC GeoSearch                  | The only free service that reads addresses. Its confidence score is always 0.8, so we check ourselves that the house number, street and borough match what was asked.     |
| BBL → lot details       | PLUTO (64uk-42ks)              | One row per lot: borough, block, lot, building class, units. Also the source of the 10,000-lot scale seed.                                                                |
| BBL → all BINs          | Building Footprints (5zhs-2jue)| The only source that lists every building on a lot. We query both `base_bbl` and `mappluto_bbl`, because for condos `base_bbl` is the ground lot and only `mappluto_bbl` carries the condo billing lot. |

Violations are joined by BIN, never by block/lot, because block/lot padding
is inconsistent in the ECB data (the same lot appears as `0041` and `00041`).

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

**No authentication.** `/admin/*` triggers work and exposes the run log;
in production it would sit behind auth. Out of scope here.

## Spot checks against the city

Two properties checked against the city's own records on 2026-09-21. Our
copy of the ECB dataset was last updated by the city on 2026-09-19
(`coverage.sourceUpdatedAt`).

**Against OATH, the hearings tribunal.** OATH keeps its own record of every
ECB ticket (dataset `jz4z-kudi`, a different agency and a different system
from DOB's ECB dataset, updated 2026-09-21), keyed by ticket number with its
own balance, penalty and paid amounts. We looked up every ticket number we
hold for each property (OATH pads them to 10 digits: our `39558924X` is its
`039558924X`) and compared money row by row.

| Property             | BIN     | Violations (ours) | Unpaid violations (ours) | Total balance owed (ours) | Tickets found in OATH | Unpaid violations (OATH) | Total balance owed (OATH) | Tickets whose balance differs | Match |
|----------------------|---------|------------------:|-------------------------:|--------------------------:|----------------------:|-------------------------:|--------------------------:|------------------------------:|-------|
| 350 5th Avenue (ESB) | 1015862 |               241 |                        0 |           -$3,060 (credit) |                   161 |                        0 |                   -$3,060 |                             0 | yes   |
| 939 2nd Avenue       | 1038249 |                51 |                       21 |                  $434,250 |                    30 |                       21 |                  $434,250 |                             0 | yes   |

"Unpaid violations" is how many of the property's tickets still have money
owed (`balance_due > 0`). "Total balance owed" adds up `balance_due` over all
the property's tickets, settled ones included. ESB's total is negative
because two closed tickets were over-paid and carry a credit, which is also
why ESB is not listed under `unpaid=true`: a credit is not a debt.

Every ticket OATH has, we have, with the same balance to the dollar; the
unpaid rows and totals are identical. The tickets OATH lacks are the old
ones: for ESB all 80 missing were issued 1988–1999 and all 161 present were
issued 2000 or later; for 939 2nd Avenue the 21 missing were issued 1993–95.
OATH's public dataset simply starts later than DOB's, so the difference is
coverage, not disagreement.

**Against BIS (DOB's Building Information System).** The pages are
[ESB](https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=1015862)
and [939 2nd Avenue](https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=1038249);
the "Violations-ECB" line shows open and total counts. BIS sits behind
Akamai and returned 403 from every route we had on 2026-09-21 (a non-US
home connection, a New York VPN exit, a US cloud fetch), so its cells are
not filled in. It opens from a US residential connection; our expected
values are 0 open / 241 total and 21 open / 51 total.

**Why counting by lot gives a smaller number.** ECB rows carry the lot as
typed over the years, sometimes 4 digits, sometimes 5. Counting by block and
lot returns only one spelling; counting by BIN returns all of them. Both
spot-check properties split this way:

| Query on the ECB dataset                    | Rows |
|---------------------------------------------|-----:|
| ESB: `block='00835' and lot='0041'`         |   94 |
| ESB: `block='00835' and lot='00041'`        |  147 |
| ESB: `bin='1015862'`                        |  241 |
| 939 2nd Ave: `block='01323' and lot='0128'` |   43 |
| 939 2nd Ave: `block='01323' and lot='00128'`|    8 |
| 939 2nd Ave: `bin='1038249'`                |   51 |

94 + 147 = 241 and 43 + 8 = 51: the BIN join captures every row. This is
why violations are attached to properties through `property_bins` and never
by block/lot.

## Secrets

`SOCRATA_APP_TOKEN` in `.env` (see `.env.example`). Optional; lifts the
unauthenticated rate limit. Never committed.