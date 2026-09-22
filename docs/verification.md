# Verification

Evidence that the system does what the README says: the run logs, the
10,000-lot scale run, the spot checks against the city, and the tests.

## The 10,000-lot scale run

`../seed/scale-10k.csv` is the first 10,000 lots of Brooklyn community district
301 (Williamsburg/Greenpoint), by BBL, pulled from PLUTO with `npm run
seed:pluto` (the script is the provenance). Load and run:

```sh
docker compose run --rm api npm run import -- seed/scale-10k.csv
docker compose run --rm api npm run ingest
```

Measured on 2026-09-22 (`../runlogs/scale-10k.txt`): the import resolved
10,000 lots in 43 s with 40 PLUTO calls and 40 Building Footprints calls
(9,462 with buildings, 521 vacant or placeholder-only, 17 condo unit lots;
9,983 lots got PLUTO facts, since the condo unit lots are never asked). The
run fetched 37,574 violations for 10,742 BINs with 19 Socrata calls in 18
batches, 0 failed, in 72 s. Two more runs the same morning took 44 s at the
same 19 calls, and 78 s at the old 1,000-row page size (44 calls): the
city's response time varies more than our call count does, and the larger
page is faster on both counts. A second run over the same lots stores 0 new
rows. `../runlogs/kill-resume.txt` shows the same run killed after batch 5
and finished by the next start.

## Run logs

`../runlogs/` is untouched console output, recorded on 2026-09-22 from a
fresh database with the final code: `baseline.txt` (seed, first run),
`second-run.txt` (same commands again: 0 new, 0 changed), `scale-10k.txt`
(the import and the 10,000-lot run), `kill-resume.txt` (a run killed after
batch 5, resumed by the next start). History worth keeping: the first-ever
10,000-lot import (2026-09-20) ran with a 500-lot Footprints batch, got
HTTP 414 on every call and left 9,983 lots `pending`; nothing was lost,
lowering the default to 300 and re-running settled them, and that is why
the default is 300.

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
| BBL → lot details       | PLUTO (64uk-42ks)              | One row per lot: borough, block, lot, building class, units, and the lot's official address, which is the `normalizedAddress` of a lot registered by BBL. Also the source of the 10,000-lot scale seed. |
| BBL → all BINs          | Building Footprints (5zhs-2jue)| The only source that lists every building on a lot. We query both `base_bbl` and `mappluto_bbl`, because for condos `base_bbl` is the ground lot and only `mappluto_bbl` carries the condo billing lot. |

Violations are joined by BIN, never by block/lot, because block/lot padding
is inconsistent in the ECB data (the same lot appears as `0041` and `00041`).

