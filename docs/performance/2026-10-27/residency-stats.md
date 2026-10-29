# Imagery residency stats — 27 October 2026

Uncommitted local work in engine. There is no commit yet.

`stats()` in `src/terrain/imagery/imageryResidency.ts` walks every resident
entry. The imagery runtime reads it three or four times a frame. The counts
now stay cached until something that can change them actually changes. Each
call still returns a new object, copied from the cache, so a caller that
keeps the previous snapshot and mutates `limits` does not see later writes
and does not leak into the cache.

A generation counter (`statsEpoch`) bumps with the cache clear. The walk
stores its result only when the generation is unchanged at the end. A change
notification that reenters during the walk, including one fired while a
missing record expires, does not store a half-updated pass.

These writes clear the cache: entry state, slots and reserved bytes, demand,
missing records, pins, overflow, unplaced, upload counters, in-flight
uploads, upload refusals, and dispose. An idle `pump()`, an upload that
places nothing, and `setPinned` of the same slots do not. A missing record
is a change once `now()` reaches `missingWakeAt`, because expiry changes the
missing count. An empty missing set has nothing left to expire.

`refreshFeedback` in `createImageryRuntime.ts` only reads the result. That
file was not edited.

## Tests

`tests/imageryResidency.test.ts` still sees a new upload, an eviction, and a
new missing image on the next `stats()` call. The same file covers an
unplaced upload, expiry of a missing record, a retried failure, an idle
pump, and a same-slots pin. The file passed 21 tests.

## Timing

Node, 4,000 resident images and 200 missing records, median of five loops of
2,000 calls:

| Arm | µs/call |
| --- | ---: |
| Walk every time | 9.4 |
| Cached counts | 0.028 |

Scratch for the timing lives under `engine/build/perf-residency-stats/`.
This is not a frame-rate claim. The 27 October browser profile still shows
the old `stats` cost of about 14 ms/s at 4×, because this change was not in
that profile.

## P-106: empty missing-set queue scan — 28 October

Kept as uncommitted local work alongside P-102. `fillQueue()` now runs its
initial demand-order missing scan only when the private `missing` map is
nonempty. With an empty map every old `isMissing()` returned false before
calling `now()` or an expiry notification. The pass could not populate
`skipped`, expire anything, or reenter. Production requests have plain data
fields (`createImageryRuntime.ts`'s request factory); this proof does not
promise the same number of reads for side-effecting property getters.

The nonempty scan is unchanged, including its order when expiry callbacks
reenter. Queue bounds, coverage ordering, retry and overflow handling, and
P-102's invalidation remain unchanged. No floating-point expression changed.

### Paired Node measurement

Scratch: `engine/build/perf-fillqueue-20261028/`. Run from `engine/`:

```sh
node build/perf-fillqueue-20261028/bench.mjs
```

Node v26.9.0 strips types from snapshots of the current P-102 working file
and the candidate. Only that file differs between arms: the script asserts
the exact guard replacement. Both use the same copied `retryDelay` dependency
and the same build-only method exposing the closed-over `fillQueue()`.
The two baseline modules are byte-identical. Source files are never swapped
in the working tree.

Each fixture contains resident demand, optionally with live missing demand.
Two warmup batches precede 30 rounds of 2,000 calls. Each round has an
adjacent baseline/baseline control pair and an adjacent baseline/candidate
pair; pair order reverses each round. Final stats match between all arms.
`results.json` retains every ordered sample; `bench.log` has summaries.

| Isolated `fillQueue` fixture | Baseline median, ms/2,000 | Candidate median | Median paired saving | Faster pairs |
| --- | ---: | ---: | ---: | ---: |
| 256 resident, no missing | 4.172 | 2.663 | 36.12% | 30/30 |
| 4,000 resident, no missing | 87.370 | 60.618 | 30.85% | 30/30 |
| 4,000 resident, 200 missing | 145.738 | 138.304 | Inside control noise | 21/30 |

The empty-set candidate separates from the complete control range. At 256
residents, paired savings were 33.72–38.65%, against −3.83–4.33% for unchanged
source. At 4,000 residents, savings were 27.67–32.72%, against −5.12–3.53%.
The nonempty path shows no proven gain: its apparent 5.02% lies within the
control's −33.06–10.06% range.

Public `pump()` was also measured in the same sequence. Empty-set medians
were 6.841 → 5.366 and 130.512 → 101.418 ms/2,000, but control spikes span
the apparent savings, so those are inconclusive. With 200 missing records,
`pump()` was 185.675 → 183.604 ms/2,000, also inside control noise. The
retention decision rests only on isolated `fillQueue` with no missing
records. None of these Node timings is a frame-rate claim. The 27 October
9.4 ms/s profile predates this change; there is no browser measurement.

### Validation

- Targeted tests: 84 pass in residency, prepared lifetime, imagery runtime,
  runtime continuity, and the preserved terrain-light tests. The new
  residency regression covers empty → live → expired → empty missing state,
  coverage order, queue bounds, overflow, and retry admission.
- The same 22 residency tests pass against the saved P-102 baseline.
- A 600-seed replay of 250 operations each compares baseline and candidate
  after every operation: requests and aborts, stats, revisions, wake times,
  notifications, errors, free slots and residency. Vitest structural equality
  uses `Object.is` for numbers; priorities include NaN, signed zero and
  infinities. All 600 pass. This replay remains in ignored scratch.
- ESLint and a TypeScript project including the two edited files pass.
- Engine-wide `npm run typecheck` reports the existing error in preserved
  P-101 at `terrainLightPlugin.ts:516`: its `UniformBuffer` intersection with
  `_currentEffect` reduces to `never` because Babylon declares that property
  private. The P-101 source and test were left byte-for-byte unchanged.
  The full engine test suite was not run while the other agent's files were
  dirty.

P-105 remains open for the entry count, ordered-demand walk, and nonempty
missing path. P-106 is only this empty-map cut.
