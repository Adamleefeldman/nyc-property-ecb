# DESIGN

How the system is built and why. A **BBL** is a tax lot, a **BIN** is a
building (DOB datasets, including ECB, are keyed by BIN), **Socrata** is the
city's open-data API, and a **run** is one pass of the pipeline.

## 1. Ingestion strategy: watchlist pull

**The choice.** Every week we need the city's ECB rows for the buildings we
track, without calling the city at request time. Two ways to get there:

- **A. Watchlist pull.** Each run sends the city our BINs in batches
  (`$where=bin in (...)`, 600 per call) and stores what comes back.
- **B. Dataset mirror.** Copy the whole 1.8M-row dataset once, then each run
  pull only rows changed since last time (`:updated_at`) and join locally.

**The numbers.** Measured on the live dataset (2026-09-16: 1,835,264 rows,
~4,700 new per weekday, 50,000-row pages of ~53 MB in ~5.5 s, ~1,000 BINs per
call before the URL is rejected) and on the real 10,000-lot run (2026-09-22:
10,742 BINs, 18 batches, 19 calls with 5,000-row pages, 37,574 rows, 44 to
72 s across three runs at 250 ms between calls):

|                                      | A. Watchlist                          | B. Mirror                                 |
|--------------------------------------|---------------------------------------|-------------------------------------------|
| Calls per run, 10,000 properties     | 19 (measured)                         | ~2, after a one-time 37-call, 2 GB load   |
| Calls per run, 20,000 properties     | ~37 (36 batches plus metadata)        | ~2                                        |
| Calls per run, 20,000 × 10 datasets  | ~370                                  | ~20                                       |
| Wall time per run                    | 44 to 72 s measured; ~2 min at 20,000 | seconds, after a 4+ min initial load      |
| Rows stored, 10,000 properties       | 37,574 (measured)                     | 1.8M for ECB; 11M more for HPD            |
| Cost grows with                      | tracked buildings × datasets          | datasets only                             |

The city allows about 1,000 anonymous calls an hour, more with an app token.
Both options sit far inside that, so rate limits do not decide this.

**What does.** A knows, per property, whether we asked and whether the
answer came back: exactly the "checked / not checked / failed" the API must
show, where B can only say the whole copy is stale. A re-fetches each
building's full set every run, so changes and deletions are a diff; B's
`:updated_at` misses deletions, and this dataset deletes and reinserts rows
rather than editing them, so B would need a second sweep over all 1.8M keys.
A is one mechanism and starts in seconds on a clean laptop; B is three
(initial load, delta, key sweep) behind a 2 GB download. B wins on a newly
added property (answered at once, not at the next run) and on a dataset
with no BIN or BBL column.

**Decision: A.** Per-property coverage, change detection as a diff, one
mechanism, and it matches the brief: resolve once, then scan by identifiers.

**When we would switch to B.** (1) A dataset with no BIN or BBL column.
(2) A dataset small enough that copying beats scanning: roughly when its
rows are fewer than tracked BINs × rows per BIN. (3) Tracked BINs × datasets
× run frequency makes A's calls or freshness lag unacceptable; at 20,000
properties and ten datasets that is ~370 calls a day, well under the hourly
limit, so that point is far off. A hybrid is natural: mirror small reference
datasets, watchlist the large transactional ones.

## 2. Storage layout

Eight tables in five migrations (`src/db/migrations/`), applied on every
boot under a database lock so two containers cannot race.

| Table | One row per | Key | Holds |
|---|---|---|---|
| `properties` | tracked property | `id`; `bbl` unique | borough/block/lot, normalized address, PLUTO facts, resolution status and reason |
| `property_inputs` | raw input received | `(kind, input_key)` | audit trail and cache: every spelling points at one property |
| `property_bins` | building on a property | `(property_id, bin)` | `is_placeholder` (…000000 BINs are stored, never queried) |
| `ecb_violations_raw` | violation as the city sent it | `ecb_violation_number` | untouched JSON, Socrata's `:id` / `:updated_at`, `fetched_at`, `run_id` |
| `ecb_violations` | violation as we serve it | same, FK to raw | typed columns, `content_hash`, first / last seen run, `absent_since_run_id`, `updated_at` |
| `property_coverage` | property × dataset | `(property_id, dataset)` | `checked` / `failed`, `checked_at`, `run_id`, city's update time, error, `last_success_at` |
| `ingestion_runs` | pipeline run | `id` | trigger, status (running / succeeded / partial / failed), city's update time, counters, error |
| `ingestion_batches` | batch inside a run | `(run_id, batch_no)` | `bins[]`, `property_ids[]`, status (pending / succeeded / failed), attempts, error |

**Raw and normalized are separate on purpose.** The raw row is provenance:
what the city sent, when we fetched it, in which run. The normalized row is
what the API serves: typed, padded, hashed. If we mis-parse a field,
`npm run renormalize` rebuilds every served row from raw with no network
call, and only rows whose served values change get a new `updated_at`. Raw
rows are never deleted; a served row cannot exist without its raw evidence.

**Join by BIN, never by block and lot.** The ECB data pads lot numbers
inconsistently (`0041` and `00041` for one lot); only the BIN finds every row
(counts in `docs/verification.md`). Three indexes match the three read
paths: `(bin, issue_date DESC, number)` for a property's list,
`(updated_at, number)` for the cross-property scan, and a partial index on
`bin WHERE balance_due > 0` for the unpaid filter (about 9% of rows). A
fourth, on `property_bins (bin)`, maps a violation back to its properties in
the cross-property scan.

## 3. Idempotency and partial failure

**Every write is an upsert on a natural key**: properties on `bbl`, inputs
on `(kind, input_key)`, buildings on `(property_id, bin)`, violations on
`ecb_violation_number`, coverage on `(property_id, dataset)`, batches on
`(run_id, batch_no)`. Running the same seed, import or ingest twice changes
nothing (`runlogs/second-run.txt`: 0 new, 0 changed).

**The plan is written before the first fetch.** A run groups the tracked
BINs into batches of 600 and stores every batch as `pending`, in one
transaction with the run row, before calling the city. Each batch is then one
transaction: fetch all pages, upsert raw and normalized rows, stamp coverage
for its properties, mark the batch done. A process that dies mid-run leaves
a `running` run with `pending` batches; the next start, scheduled or manual,
adopts it and continues from the first pending batch. Finished batches are
never re-fetched (`runlogs/kill-resume.txt`).

**A failing batch fails alone.** After the retry limit (429, 5xx and
timeouts retried with backoff; other 4xx never), the batch is marked `failed`
with its error, its properties' coverage becomes `failed` with the time, the
error and their last success kept, and the run moves on. A run with any
failed batch closes as `partial`, never `succeeded`, so the failure shows in
the run row, the batch row and every affected property's response. The next
run retries them like any other.

**Change detection is a hash, not a timestamp.** `updated_at` moves only
when the served values change, so "what changed since" is honest even though
the city re-saves unchanged rows. A row the city stops returning is flagged
`absent_since_run_id` and kept, not deleted.

**One run at a time**, through a Postgres advisory lock: a second trigger
gets 409, or exit code 2 on the command line. Resolver outages follow the
same idea: the property is stored as `pending` with the error and returns
202; a retry settles it under the same id.

## 4. Freshness and coverage

Every violations response carries a `coverage` envelope, so an empty list is
never ambiguous:

| State | Comes from | Means |
|---|---|---|
| `checked` | `property_coverage.state = checked` | We asked about this property's BINs in run `runId` at `checkedAt`. `items` is the answer, even if empty. |
| `not_checked` | no coverage row | Registered, but no run has reached it yet, or its building lookup is still pending. `reason` says which. |
| `not_applicable` | `properties.resolution_status` | No usable building ID: vacant lot, placeholder BINs only, condo unit lot. `reason` says why. |
| `failed` | `property_coverage.state = failed` | The last attempt errored. `failedAt`, `error` and `lastSuccessAt` say when, why, and when it last worked. Rows from that success are still served. |

Two clocks, both exposed: `checkedAt` is ours (when the run covered this
property); `sourceUpdatedAt` is the city's (the dataset's own last-update
time, read from Socrata's metadata once per run). On each row, `updatedAt`
is when we stored it or its values last changed. Coverage is keyed by
`(property_id, dataset)`, so a second dataset gets its own states.

## 5. What we would build next, and refactor first

**Refactor first: a dataset adapter.** The ECB-specific parts (the
`bin in (...)` query, the normalizer, the two table names) are spread over
four files. Behind one interface, the planner, lock, batches, resume and
coverage are written once:

```ts
interface DatasetAdapter {
  id: 'ecb' | 'hpd';
  fetch(client, bins): AsyncIterable<RawRow[]>;   // paging inside
  normalize(raw): NormalizedRow | null;
  upsert(db, raws, normalized, runId): StoreResult;
}
```

About two hours with the tests as the safety net, and the same seam would
let strategy B replace A for a small dataset.

**Second data point: HPD violations** (`wvxf-dwi5`, 11.2M rows, has `bin`).
Reuses the Socrata client, planner, run bookkeeping, coverage table
(`dataset = 'hpd'`) and cursors; needs its own raw and normalized tables, a
normalizer and one endpoint. `docs/adding-a-dataset.md` is the step-by-step.

**Change events.** The pipeline already knows, at write time, what alerting
needs: `first_seen_run_id` means new, `updated_at` moved means changed,
`absent_since_run_id` means removed. The build is one table,
`violation_events (run_id, violation_number, kind, before, after)`, written
in the same batch transaction, and one paginated endpoint. No extra fetch,
no diff job.

**Smaller, in order.** Make `POST /properties/bulk` and
`POST /admin/ingest/run` asynchronous (202 with an id to poll; bulk is about
4 s per 1,000 lots today). Put `/admin/*` behind a token. For a lot with no
Footprints row, fall back to the BIN GeoSearch returns.
