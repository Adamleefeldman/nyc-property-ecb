# DESIGN

## 1. Ingestion strategy: watchlist pull (A)

### The question

We track ~12,000 building IDs (BINs) for 10,000 properties. The city publishes
1.8M ECB violation rows, each stamped with a BIN. Every week we need to know
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
of ~53 MB / ~5.5 s, ~4,700 new rows per weekday. Assumes 1.2 BINs per property.

|                                  | A. Watchlist           | B. Mirror                              |
|----------------------------------|------------------------|----------------------------------------|
| Calls per run, 10k properties    | ~20                    | ~2 (after a one-time 37-call, 2 GB load) |
| Calls per run, 20k properties    | ~40                    | ~2                                     |
| Calls per run, 20k × 10 datasets | ~400                   | ~20                                    |
| Wall time per run (1 call/s)     | 1–2 min                | seconds (4+ min initial load)          |
| Rows stored                      | ~20–50k                | 1.8M for ECB; 11M more for HPD         |
| Cost grows with                  | tracked BINs × datasets| datasets only                          |

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
   ~400 calls a week, so this point is far off.

A hybrid is natural: mirror small reference datasets (a PLUTO slice for the
resolver), watchlist the large transactional ones (ECB 1.8M, HPD 11M).

### Keeping the door open

The pipeline has one step, "fetch current rows for these BINs", behind an
interface. A implements it with `bin in (...)` calls; B would implement it
with a local table lookup. Raw/normalized storage, coverage metadata and the
API do not change.

## 2. Storage layout

_TODO_

## 3. Idempotency and partial failure

_TODO_

## 4. Freshness and coverage

_TODO_

## 5. What we would build next, and refactor first

_TODO_
