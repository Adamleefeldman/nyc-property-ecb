# Adding a dataset

Worked example: HPD housing-maintenance violations (`wvxf-dwi5`, 11.2M
rows, columns include `bin` and `bbl`). Everything below the line "reused"
is not touched.

## What is reused

- `src/socrata/fetch.ts` — the client: pacing, retries, the 414 guard.
- `src/pipeline/planner.ts` — groups tracked BINs into batches.
- `src/pipeline/ingest.ts` — run lock, batch plan, per-batch transaction,
  resume, partial status, counters.
- `src/pipeline/store.ts` — run and batch bookkeeping, `markCovered` /
  `markCoverageFailed`. `property_coverage` and `ingestion_runs` are
  already keyed by `dataset`; the column defaults to `'ecb'`, so these
  functions gain a `dataset` parameter (step 5) rather than new tables.
- `src/api/coverage.ts`, `src/api/cursor.ts` — the envelope and paging.
- `property_bins` — the BINs to scan are the same ones.

## The three files to write, in order

### 1. A source module: `src/pipeline/hpd-source.ts`

Copy `ecb-source.ts`. Change the dataset id, the row interface (HPD's
column names), and nothing else. The shape stays
`fetchHpdViolations(client, bins, { pageSize, maxPages }) → HpdRow[]`, paged
on `:id` with `$select=*,:id,:created_at,:updated_at`. Keep the star first;
Socrata drops the system columns otherwise.

### 2. A normalizer: `src/pipeline/hpd-normalize.ts`

Copy `normalize.ts`. Map HPD's columns to typed fields (HPD dates are
ISO, not `YYYYMMDD`, so `parseYyyymmdd` gives way to `Date.parse`), pad
block/lot as ECB does, and compute `content_hash` over exactly the fields
the API will serve. Return `null` for a row with no usable key. Unit-test
it with two or three real rows in `src/pipeline/fixtures/hpd.ts`.

### 3. A migration: `src/db/migrations/0005_hpd.sql`

Two tables with the same shape as `ecb_violations_raw` / `ecb_violations`:
raw keyed on HPD's `violationid`, normalized keyed the same with an FK to
raw, `content_hash`, the three seen markers, `updated_at`. Three indexes:
`(bin, <date> DESC, key)`, `(updated_at, key)`, and a partial one for
whatever the dataset's "open" predicate is (HPD: `currentstatus <>
'VIOLATION CLOSED'`). Nothing else changes: `property_coverage` and
`ingestion_runs` already carry `dataset`.

## Then wire it

4. `src/pipeline/store.ts`: add `upsertHpdRaw` and `upsertHpdNormalized`
   (copy the ECB pair, change table and column names; the `ON CONFLICT`
   pattern with `content_hash` and `xmax = 0` is the same).
5. `src/pipeline/ingest.ts`: today `runIngestion` imports the ECB fetch and
   normalizer directly. Either pass them in (`runIngestion(db, socrata,
   { ...opts, source, normalize, upsert, dataset: 'hpd' })`) or do the
   adapter refactor DESIGN.md §5 describes first, which is the cleaner
   route. `startRun`, `markCovered`, `markCoverageFailed`,
   `findUnfinishedRun` and `lastSuccessfulRunAt` get a `dataset` parameter
   in place of the `'ecb'` default / literal.
6. `src/api/violations.ts`: copy the two ECB routes to
   `GET /properties/:id/hpd-violations` and `GET /hpd-violations`, pointing
   at the new table and its filters; `coverageFor` in `src/api/coverage.ts`
   gets a `dataset` parameter in place of its `'ecb'` literal. Register the
   routes in `src/api/app.ts`.
7. Scripts: `npm run ingest` takes a `--dataset hpd` flag (or a second
   script), and `renormalize.ts` gets the same switch.
8. README: one example request and response per new endpoint; DESIGN.md
   §2 gains two table rows.

## Checks before calling it done

- `npm test` green with an `hpd.integration.test.ts` that ingests two rows
  through the fake city, changes one, re-ingests, and sees exactly one
  `updatedAt` move.
- A property in the seed reports `coverage.state: checked` for HPD with an
  empty list, so the "none versus unknown" distinction is demonstrable for
  the new dataset too.
- `runlogs/` gains a baseline and second-run log for HPD.
