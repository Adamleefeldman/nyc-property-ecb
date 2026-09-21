# DESIGN

## 1. Ingestion strategy: watchlist pull (A)

### The question

We track ~10,700 building IDs (BINs) for 10,000 properties (measured: 1.07
BINs per lot in Williamsburg). The city publishes 1.8M ECB violation rows,
each stamped with a BIN. Every week we need to know
what those rows say about our buildings, without calling the city's API at
request time. There are two ways to get there.

### The two options

**A. Watchlist pull.** Each run, send the city our list of BINs in batches
(`$where=bin in (...)`, ~600 BINs per call) and store the rows that come back.

**B. Dataset mirror.** Copy the whole dataset once, then each day pull only
rows changed since the last run (Socrata's `:updated_at` field) and look up
our buildings in the local copy.

### The numbers

Measured against the live dataset (2026-09-16): 1,835,264 rows, ~1,000 BINs
per `in (...)` call before the URL is rejected (we use 600), 50,000-row pages
of ~53 MB / ~5.5 s, ~4,700 new rows per weekday. Then measured on the real
10,000-lot run (2026-09-20, `runlogs/scale-10k.txt`): 10,742 BINs, 18
batches, 44 calls (a batch with more than 1,000 rows pages), 37,574 rows,
49 s wall time with 250 ms pacing.

|                                  | A. Watchlist (measured / extrapolated) | B. Mirror                            |
|----------------------------------|----------------------------------------|--------------------------------------|
| Calls per run, 10k properties    | 44 (measured)                          | ~2 (after a one-time 37-call, 2 GB load) |
| Calls per run, 20k properties    | ~90 (36 batches + paging)              | ~2                                   |
| Calls per run, 20k × 10 datasets | ~900                                   | ~20                                  |
| Wall time per run                | 49 s measured; ~2 min at 20k           | seconds (4+ min initial load)        |
| Rows stored, 10k properties      | 37,574 (measured)                      | 1.8M for ECB; 11M more for HPD       |
| Cost grows with                  | tracked BINs × datasets                | datasets only                        |

At 20k properties a daily run is ~90 calls against an anonymous limit of
~1,000 an hour; with an app token the limit is higher still.

Both are far inside what Socrata tolerates. **Rate limits do not decide this.**

### What does decide it

| Concern                                  | A. Watchlist                              | B. Mirror                                              |
|------------------------------------------|-------------------------------------------|--------------------------------------------------------|
| "Checked / not checked / failed" per property | Native: we asked about these BINs, we know which batch failed | Only dataset-level ("copy stale since Tuesday") |
| Seeing changes and deletions             | Native: each run re-fetches each BIN's full set; diff against last run | `:updated_at` misses deletions, and this dataset never edits rows in place (delete + reinsert). Needs a second mechanism: a weekly sweep of all 1.8M keys |
| Newly added property                     | Answered at next run (or a small on-demand fetch) | Answered instantly                             |
| Dataset with no BIN/BBL column           | Not possible                              | Fine                                                   |
| Clean-laptop demo                        | Starts in seconds                         | 2 GB download first                                    |
| Mechanisms to build and test             | One                                       | Initial load + delta + key sweep                       |

### Decision

**A.** It produces the per-property coverage states the API must expose, it
makes change detection a diff, it is one mechanism, and it starts instantly.
It also matches the brief: "a property is resolved once; after that we hold
its identifiers and scan by them."

### When we would switch to B

1. A dataset has no BIN or BBL column, so there is nothing to batch on.
2. A dataset is small enough that copying it is cheaper than scanning it
   (rule of thumb: dataset rows < tracked BINs × rows per BIN).
3. Platform-wide tracked BINs × datasets × run frequency makes A's call count
   or freshness lag unacceptable. At 20k properties and 10 datasets that is
   ~900 calls a day, still under the anonymous hourly limit, so this point
   is far off.

A hybrid is natural: mirror small reference datasets (a PLUTO slice for the
resolver), watchlist the large transactional ones (ECB 1.8M, HPD 11M).

### Keeping the door open

The pipeline has one step, "fetch current rows for these BINs", behind an
interface. A implements it with `bin in (...)` calls; B would implement it
with a local table lookup. Raw/normalized storage, coverage metadata and the
API do not change.

## 2. Storage layout

Eight tables in four migrations (`src/db/migrations/`), applied in order on
every boot under an advisory lock so two containers cannot race.

| Table | One row per | Key | Holds |
|---|---|---|---|
| `properties` | property we track | `id` uuid; `bbl` unique (nullable while an address is still pending) | borough/block/lot, `normalized_address`, `pluto` facts, `resolution_status` (resolved / unresolved / pending / not_applicable), source, reason, timestamps |
| `property_inputs` | raw input ever received | `(kind, input_key)` → `property_id` | the audit trail and the cache: "350 Fifth Ave", "350 5th Avenue" and the BBL all point at one property |
| `property_bins` | building on a property | `(property_id, bin)` | `is_placeholder` (…000000 BINs are stored but never queried), source column |
| `ecb_violations_raw` | violation as the city sent it | `ecb_violation_number` | the untouched JSON payload, Socrata's `:id` / `:created_at` / `:updated_at`, `fetched_at`, `run_id` |
| `ecb_violations` | violation as we serve it | `ecb_violation_number` (FK to raw) | typed columns: dates, money as `numeric(14,2)`, status, BIN/BBL; `content_hash`; `first_seen_run_id`, `last_seen_run_id`, `absent_since_run_id`; `updated_at` |
| `property_coverage` | property × dataset | `(property_id, dataset)` | `state` checked / failed, `checked_at`, `run_id`, `row_count`, `source_rows_updated_at`, `error`, `failed_at`, `last_success_at` |
| `ingestion_runs` | pipeline run | `id` | trigger (cli / scheduler / api), status running / succeeded / partial / failed, `source_rows_updated_at`, counters (calls, fetched, stored, new, changed), `batches_total`, `batches_failed`, error |
| `ingestion_batches` | batch inside a run | `(run_id, batch_no)` | `bins[]`, `property_ids[]`, status pending / succeeded / failed, attempts, rows, error, timing |

**Raw versus normalized.** Every violation is stored twice on purpose. The
raw row is provenance: what the city said, when we fetched it, in which
run. The normalized row is what the API serves: typed, padded, hashed. The
raw copy makes the normalizer replaceable. If we discover a date format we
mis-parsed or want a new column, `npm run renormalize` rebuilds every
served row from the raw payloads without a network call, and the
`content_hash` guarantees only rows whose served values actually change get
a new `updated_at`. Raw rows are never deleted; the FK from normalized to
raw means a served row cannot exist without its evidence.

**Why BIN is the join.** Violations attach to properties through
`property_bins`, never through block and lot: the ECB data carries lots as
typed over thirty years (`0041` and `00041` for the same lot), and only the
BIN captures every row (`docs/verification.md`, "Spot checks").

**Indexes** follow the three read paths: `(bin, issue_date DESC, number)`
for a property's list, `(updated_at, number)` for the cross-property scan,
and a partial `(bin) WHERE balance_due > 0` for the unpaid filter: only
~9% of rows are unpaid (162k of 1.8M city-wide), so the partial index is
small and the filter never scans settled rows.

## 3. Idempotency and partial failure

**Every write is an upsert on a natural key.** Properties on `bbl`; inputs
on `(kind, input_key)`; buildings on `(property_id, bin)`; violations on
`ecb_violation_number`; coverage on `(property_id, dataset)`; batches on
`(run_id, batch_no)`. Running the same seed, import or ingest twice changes
nothing: `runlogs/second-run.txt` shows 0 new, 0 changed after the baseline,
and the resumed 10,000-lot run stored 0 new.

**Change detection is a hash, not a timestamp.** The normalized row carries
`content_hash` over the served fields. The upsert sets `updated_at = now()`
only when the incoming hash differs, so `GET /ecb-violations?updatedSince=`
returns rows whose *served values* changed, not rows the city re-saved
without changing. This matters because Socrata never edits ECB rows in
place: it deletes and reinserts, so `:id` and `:updated_at` move even when
nothing did.

**Seen markers instead of deletes.** Each run stamps the rows it saw
(`last_seen_run_id`). A row a run *should* have seen (its BIN was in a
succeeded batch) but did not gets `absent_since_run_id`; it stays served,
flagged, because the city drops and restores rows and a disappearance is a
fact worth keeping.

**The plan is written before the first fetch.** A run groups the tracked
BINs into batches of `BATCH_SIZE` (600; the URL limit is ~16 KB) and inserts
every batch as `pending` into `ingestion_batches` inside one transaction
with the run row. Only then does it start calling the city. Each batch is
processed in its own transaction: fetch all pages, upsert raw, upsert
normalized, mark coverage for the batch's properties, mark the batch
`succeeded` with its counters. A process that dies mid-run (power, deploy,
`INGEST_KILL_AFTER_BATCH` in tests) leaves a `running` run with some
`pending` batches; the next start, scheduled or manual, adopts that run and
continues from the first pending batch. `runlogs/kill-resume.txt` shows the
resumed run reporting the full 44 calls because per-batch counters are
persisted, not held in memory.

**A failing batch fails alone.** After `MAX_ATTEMPTS` (429, 5xx and timeouts
retried with capped exponential backoff; 4xx never), the batch is marked
`failed` with the error, its properties get `property_coverage.state =
failed` with `failed_at`, `error` and their `last_success_at` preserved, and
the run moves on. A run with any failed batch closes as `partial`, never
`succeeded`, and the failure is visible three ways: the run row, the batch
row, and every affected property's coverage envelope. The next run retries
those properties like any other.

**One run at a time.** A Postgres advisory lock (`pg_try_advisory_lock`)
makes a second `npm run ingest` or `POST /admin/ingest/run` return
"run in progress" (exit 2 / HTTP 409) instead of interleaving writes. The
scheduler is deliberately dumb: it calls the same `runIngestion` the CLI
does, resumes an unfinished run on boot, and otherwise ticks on
`INGEST_INTERVAL`.

**Resolver failures are the same shape.** GeoSearch or Footprints down at
registration time stores the property as `pending` with the error and
returns 202; the id is stable and `npm run resolve:retry` (or the same
`POST` again) settles it. The 10,000-lot import hit exactly this when the
Footprints batch was too large for the URL: 9,983 lots landed `pending` with
`HTTP 414`, nothing was lost, and the re-run after lowering
`FOOTPRINTS_BATCH_SIZE` resolved them all (`runlogs/scale-10k.txt`).

## 4. Freshness and coverage

Every violations response carries a `coverage` envelope so an empty list is
never ambiguous. Four states, computed from two places:

| State | Comes from | Fields | Means |
|---|---|---|---|
| `checked` | `property_coverage.state = checked` | `checkedAt`, `sourceUpdatedAt`, `runId` | We asked the city about this property's BINs in run `runId`. `items` is the answer, including an empty one. |
| `not_checked` | no `property_coverage` row | `reason` | Registered but no run has reached it yet, or its building lookup is still `pending` (the reason says which). |
| `not_applicable` | `properties.resolution_status` unresolved / not_applicable | `reason` | There is no usable building ID: vacant lot, placeholder-only BINs, or a condo unit lot. Nothing to check. |
| `failed` | `property_coverage.state = failed` | `failedAt`, `error`, `runId`, `lastSuccessAt`, `sourceUpdatedAt` | The last attempt errored; the fields say when, why, and when it last worked. Rows from the last success are still served. |

**Two clocks, both exposed.** `checkedAt` is *our* clock: when the run that
covered this property finished its batch. `sourceUpdatedAt` is the *city's*
clock: the dataset's own `rowsUpdatedAt` from Socrata's metadata endpoint,
captured once per run and stamped on every coverage row that run writes. A
property can be checked five minutes ago against data the city last
refreshed two days ago; a reader needs both numbers, and no row-level
timestamp can supply the second one (rows are reinserted, not edited).

**Per-row freshness** is `updatedAt` on each item: when *we* stored the row
or its served values last changed (see §3). It is deliberately our clock and
the README says so, because the city's `:updated_at` is meaningless for this
dataset.

**Coverage is per property, per dataset.** `property_coverage` is keyed on
`(property_id, dataset)`, so a second dataset gets its own rows and its own
states without touching the ECB ones.

## 5. What we would build next, and refactor first

**Change events.** The seen markers and hash already record what alerting
needs: `first_seen_run_id` = new, `updated_at` moved with the hash = changed
(compare the old and new `balance_due` / `status` in the upsert to name the
change), `absent_since_run_id` set = removed. The build is one table,
`violation_events (run_id, violation_number, kind, before, after)`, written
inside the same batch transaction from the upsert's `RETURNING` clause, and
one paginated endpoint, `GET /ecb-violation-events?since=`. No extra fetch,
no diff job: the pipeline already knows the answer at the moment it writes.

**HPD violations as the second dataset** (`wvxf-dwi5`, 11.2M rows, has both
`bin` and `bbl`). It reuses the Socrata client, the batch planner, the run
and batch bookkeeping, the coverage table (`dataset = 'hpd'`) and the
cursor helpers unchanged. It needs its own raw and normalized tables, its
own normalizer, and one endpoint. `docs/adding-a-dataset.md` is the recipe.

**The refactor to do first: a dataset adapter.** Today the ECB-specific
parts of the pipeline (the `bin in (...)` query, the normalizer, the two
table names, the literal `'ecb'`) are spread across `ecb-source.ts`,
`normalize.ts`, `store.ts` and `ingest.ts`. Adding HPD would mean copying
`runIngestion` or threading a dataset argument through it. Better to pull
those parts behind one interface first,

```ts
interface DatasetAdapter {
  id: 'ecb' | 'hpd';
  fetch(client, bins): AsyncIterable<RawRow[]>;   // paging inside
  normalize(raw): NormalizedRow | null;
  upsert(db, raws, normalized, runId): StoreResult;
}
```

so `runIngestion(adapter)` becomes dataset-agnostic and the planner, lock,
batches, resume and coverage are written once. It is a two-hour change
with the tests as the safety net, and it is exactly the seam §1 promised
("fetch current rows for these BINs, behind an interface") if strategy B
ever replaces A for a small dataset.

**Smaller items, in the order we would take them.**

1. `POST /properties/bulk` is synchronous and takes ~2 s per 1,000 lots;
   at 10,000 it is a 25-second request. The async variant returns 202 with a
   job id and the same counts on `GET /jobs/:id`.
2. `GET /properties?unpaid=true` aggregates balances with a LATERAL join per
   page; fast at 10k, but a materialized `property_totals` refreshed at the
   end of each run is the fix if it slows.
3. `/admin/*` has no authentication; a bearer token from `.env` is the
   minimum before any shared deployment.
4. Building Footprints has gaps (Madison Square Garden's lot has no
   footprint row, so it lands `not_applicable`); for a lot with no
   footprints, falling back to the BIN GeoSearch returns for the lot's PLUTO
   address would close most of them.
5. Move the GeoSearch fixtures to a recorded-cassette format so new cases
   are captured, not hand-written.
