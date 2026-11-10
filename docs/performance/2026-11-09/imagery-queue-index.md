# Index queued imagery identities — 9 November 2026

P-160 in the performance ledger, part of P-105. Baseline: engine `4b3997a`'s
`imageryResidency.ts`, including P-102 and P-106. Local, uncommitted changes.

`fillQueue` walked every entry to count queued requests. `pump` made arrays
of every entry twice, filtering one to loading requests and one to queued
requests. Most retained entries are resident, so those copies and scans grow
with the cache rather than the active work.

The residency now keeps a private set of queued identities:

- Creating an entry or admitting a retry adds it; starting or deleting it
  removes it. All Map deletions share the same removal helper. Reset/dispose
  clear the set before cleanup callbacks can reenter.
- `fillQueue` takes its initial queue count from the set's size.
- `pump` skips its queued-entry collection when the set is empty. When
  nonempty it retains the original Map-order collection and comparator.
- Loading entries are collected directly into a small array, without first
  copying every resident entry into another array.

Only queued entries are held by the set; it adds no retained references to
resident images. It neither starts requests nor grants admission by itself.

## Exactness and reentry

The set is a memo of the Map's queued identities, not a new dispatch order.
Keeping the original nonempty dispatch path matters for NaN priorities,
whose comparator is not a total order: sorting a set in retry-insertion
order could change which request starts. No priority read or callback was
added to that sorting path.

The retry clock may reenter `setDemand` and retire the failed entry before
returning. The detached entry still follows the old local retry path, but
is added to the index only if the Map still holds that exact identity.
Starting an old dispatch snapshot removes only that entry from the set,
and deleting by key removes whichever identity the Map holds, as the old
Map deletion did.

The missing-image scan, expiry notifications, source/concurrency/staging
limits, coverage and retry admission rules, overflow accounting, upload
ordering, stats invalidation and cleanup are otherwise unchanged. Empty
queues still run the previous loading/reservation accounting, including
owned-upload byte reads. This is not an early return that skips supplied
job properties. As with the earlier P-106 proof, request fields are the
runtime's ordinary data; no promise is made about read counts of arbitrary
side-effecting property getters.

## Proof

- Frozen-reference replay: **1,000 seeds × 250 operations**, comparing
  baseline and change after every operation. Same requests and aborts,
  upload/slot outcomes, stats and limits, revisions, missing revisions,
  wake times, busy state, error notifications, change counts and free slots.
  Operations cover duplicate/replaced demand, priority changes (including
  NaN, infinities and signed zero), source changes, completions, missing and
  failed loads, time advances, pins, resource-limit changes and resets.
- Two permanent regressions in `tests/imageryResidency.test.ts`: starts and
  retirements free queue space, retries occupy it on subsequent fills, reset
  clears it, and a clock that replaces demand during retry admission cannot
  leave a phantom identity behind. All 24 residency tests also pass against
  the frozen original implementation.
- All 8 source mutants fail permanent tests: no add, no removal at start,
  no removal on deletion, no clear, no retry add, detached retry added,
  ignoring the queued count, and always dispatching an empty queue. A
  scan-based counting control passes. Mutants never replace production files.
- Final engine suite: **145 files / 1,544 tests**. Typecheck, full lint,
  build, public consumer checks and app typecheck pass. The terrain changes'
  full parity, Rust and binary receipt checks also pass.

## Timing

Node 26.9.0 on the shared M5. Three module instances: frozen baseline A,
byte-identical baseline B, and the change. Same prepared data and final
stats; one file differs. Two warmup batches, then 12 alternating adjacent
A/B pairs, each with an adjacent A/A control. **5,000 calls per timing** to
amortize the baseline's allocation/GC variation. This timing ran after the
session's tests and builds finished.

These are settled residency fixtures: every demanded image is already
resident or recorded missing. They test repeated pumping while the loader
retains a cache, not tile-arrival throughput. Medians, milliseconds per
5,000 public `pump()` calls:

| Resident / missing | Before | After | Median paired time saved |
| --- | ---: | ---: | ---: |
| 256 / 0 | 13.343 | 8.283 | 37.6% |
| 4,000 / 0 | 250.337 | 173.561 | 30.9% |
| 4,000 / 200 | 453.622 | 327.930 | 23.8% |

Every pair is faster; ranges of the arms are disjoint. Paired savings are
36.8–51.6%, 30.0–39.1% and 16.3–33.8%, above the respective unchanged-control
maxima of 22.4%, 17.4% and 10.5%. This qualifies the isolated public call,
not a frame-rate gain.

An earlier 1,000-call timing gave the small fixture's isolated `fillQueue`
1.385 → 1.102 ms (20.5% saved, 16/16 pairs beyond controls); its larger
fixtures were inconclusive. Short public-call timings fluctuated with
allocation and GC, so the table uses the longer batches. The first
index-only prototype, before direct loading-entry collection, is retained
separately and is not the final result.

There is no browser, phone, tile-loading, whole-frame or power measurement.
The still page already renders on demand; this does not introduce a timer
or make it pump while idle.

## Reproduce

Scratch: `engine/build/perf-imagery-queue-20261109/`. From engine:

```sh
node build/perf-imagery-queue-20261109/prepare.mjs
../node_modules/.bin/vitest run --config build/perf-imagery-queue-20261109/vitest.config.ts
node build/perf-imagery-queue-20261109/mutants.mjs
QUEUE_BENCH_ITERATIONS=5000 QUEUE_BENCH_ROUNDS=12 node build/perf-imagery-queue-20261109/bench.mjs --pump-only
```

`baseline.ts` freezes the old source; generated modules only expose
`fillQueue` through the same benchmark-only seam in all arms. `pump-results.json`
keeps every final ordered timing; `results.json` keeps the shorter run,
`first-results.json` the index-only prototype. Differential, mutation and
full-suite logs live beside them.
