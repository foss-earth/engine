# Terrain height packing continuation — 26 October 2026

Status: exact on the supported input/caller model and measured in plain Node on
27 October. The candidate passed the final engine suite (130 files / 1,401 tests),
typecheck, changed-file lint, build and consumer checks. It is included in the
final combined browser arm. See the flight session handoff and the October 27
`browser-results.json` for final browser and commit disposition. The isolated
packing result is not a frame-rate claim.

The engine checkout began clean at `006034f`. The 24 October change `7e61c70`
already implements the narrower sort keys and direct typed-array output described
in [height-keys.md](../2026-10-24/height-keys.md). Its source and tests are preserved.
The earlier 22 October compaction idea had not been implemented in that commit.

## Hypothesis

`packTerrainHeightPixels.add` counts unique sorted keys, then scans all visited
keys again while emitting unique pixels. Compacting unique keys into the start
of the sort buffer during counting lets the emission pass visit only that
prefix. It adds writes to the counting pass; sparse batches may lose more from
those writes than they save. Measure before adopting it.

The candidate preserves the narrow/wide key encoding, promotion, coordinate and
height conversion, byte-budget boundary, source order and output buffer sizing.
No protocol, core, verification, scheduling or default is changed.

## Exactness and frozen inputs

Everything below is ignored and local in engine `build/perf-heights-20261026/`:

- `before.ts`: frozen `006034f` packer, with type-only import paths adjusted.
  SHA-256 `0a5a6c3e80993ff8656fc91cc9fed84ba2b42b57f17a93e68cac19e88dede848`.
- `compact.ts`: candidate, same path adjustments.
  SHA-256 `d8eeff2c475f5eaf74244a4632de45ba03d594aeab8dfa08b16efafffda7847a`.
- `heights.json`: the unchanged captured C172 batches from the 24 October pass.
  SHA-256 `089bdb77adeab2f9b033ebe408858f73628e6878559479b25a660e7b774b2f95`.
- `heights.test.ts`: byte-by-byte comparison of 160 captured batches and
  1,000 randomized valid/malformed requests, retaining wide fallback coverage.
- `mutation.test.ts`: compares input getter/read order, mutation, rejected batches
  and empty batches.
- `spreads.test.ts`: unique counts, budget rejection and continuation by spread.
- `bench.mjs`: plain Node A/A and interleaved A/B, captured batches and five
  spatial spreads. Timings from Vitest are deliberately not the headline.

The original and candidate retain module-level sort scratch. A getter calling
another packer during `add` can corrupt both implementations, potentially in
different ways. The only production caller passes a plain number array and
engine grid objects; compaction does not add external callbacks. This experiment
does not establish arbitrary nested-getter reentrancy as safe. Mutation tests
retain ordinary getter observation and input mutation order.

## Reproduction

From the engine checkout, after acquiring the shared measurement lock and
checking that no older benchmark is running:

```sh
mkdir -p build/tmp
TMPDIR="$PWD/build/tmp" ../node_modules/.bin/vitest run \
  --config build/perf-heights-20261026/compact.config.ts \
  -t 'packs|matches|preserves|keeps getter'
TMPDIR="$PWD/build/tmp" node build/perf-heights-20261026/bench.mjs
```

## Results measured on 27 October

The root coordinator granted the machine-wide slot under `perf-oct27-root`.
No other build, test or benchmark ran during these measurements. All child
processes ended before the slot was released for the root browser coordinator.

- The three differential files passed: five tests, two timing tests deliberately
  excluded. The captured batches, 1,000 randomized valid/malformed requests,
  byte budgets, continuation after rejection and getter/mutation order matched.
  Wide-key fallback was exercised by 3,529 batches, including 2,627 after narrow
  keys had already been collected. Log: `differential.log` (2.89 s).
- Four production suites passed, 35 tests: height pixels, height batches,
  adversarial lifecycle/admission, and the unchanged imagery selection identity
  guard. Log: `focused.log` (24.86 s). A subsequent permanent test adds the
  previously uncovered combination of duplicate-heavy mixed-neighbour packing,
  rejection just under the budget, acceptance at the exact budget, preserved
  slot order and reuse of sort scratch. That addition passed the final complete engine suite.
- Changed-source ESLint passed. Log: `lint.log`.

Plain Node timed one request per 20 captured batches. Each captured-flight round
packs all 160 batches five times, after warmup. A/A uses two copies of the same
baseline source. A/B alternates old/new order across 30 rounds. The five synthetic
spreads use 18 batches with 4 through 4,096 coordinates, repeated ten times in
20 alternating rounds. Values below are medians in milliseconds; they are CPU
packing costs, not inclusive browser time or frame rate. A power-state check
after these short runs reported AC power, 80% battery and Low Power Mode off;
power was not sampled inside every round.

| Workload | Baseline | Candidate/control | Change |
| --- | ---: | ---: | ---: |
| Captured A/A | 4.222 | 4.234 | +0.3% |
| Captured A/B | 4.304 | 4.021 | −6.6% |
| Spread 0.001 | 6.074 | 5.276 | −13.1% |
| Spread 0.01 | 6.757 | 5.997 | −11.2% |
| Spread 0.1 | 10.774 | 9.750 | −9.5% |
| Spread 1 | 14.665 | 13.254 | −9.6% |
| Spread 1.5 | 45.851 | 43.083 | −6.0% |

A first independent run gave captured A/B 4.259 → 3.983 ms (−6.5%), with A/A
4.328 vs 4.245 ms. The repeat above retained every raw round in
`bench-raw.log`; the first medians are in `bench.log`. The candidate won 28 of 30 captured A/B rounds. Individual ranges overlap
(baseline 4.082–4.686 ms, candidate 3.825–4.495 ms), so these medians do not
establish a browser gain. The final combined browser arm also contains selector and runtime changes; it
cannot isolate this two-line packing improvement. Typechecks and the complete
engine suite pass. Its measured 6.6% packing improvement remains the precise
function-level claim.


## Rejected: skip consecutive equal keys before sorting

A private-visitor variant `dedup.ts` skips a numeric key only when equal to the
preceding stored key. It preserves the public visitor's callbacks, keeps the
first wide-key promotion, and never treats NaN as equal. The incremental
reference is the compacted candidate above. Four byte/getter/mutation
differentials passed (`dedup-differential.log`, 2.60 s).

The idea did not help: captured A/A was 4.034 vs 4.044 ms; captured A/B was
4.187 vs 4.179 ms, with only 15 of 30 paired rounds favouring the candidate.
Every synthetic spread regressed, by about 5–16%. Raw rounds are retained in
`dedup-bench.log`. No tracked source change was made for this variant.

## Rejected: avoid moving the newest LRU state

A private `batches-lru.ts` variant remembers the newest cached state and avoids
its redundant Map deletion/reinsertion. `removeState` clears the shortcut to
avoid retaining evicted point arrays. The differential retained request bytes
and order, cache provenance, 512-state and cache-size evictions, stale replies,
retirement/disposal, wrapper churn and reentrant metadata getters (two tests,
`batches-lru-tests.log`, 193 ms).

Plain Node A/A was 0.789 vs 0.794 ms per 10,000 cached one-point calls. Some
same-state patterns improved: 0.833 → 0.567 ms for one point, and
0.941 → 0.709 ms when eight states each repeat four times. But one state's
16-point calls regressed 2.384 → 2.971 ms, and two alternating states regressed
0.782 → 0.840 ms. Thirty-two alternating four-point states barely changed,
1.118 → 1.101 ms. The 160 captured flush batches contain 61 tile metadata
combinations and only two consecutive equal combinations; they do not establish
a predominance of the favourable repeated-state pattern.

These mixed synthetic results do not justify a runtime change or browser arm.
The candidate remains local and unshipped. Raw 25-round distributions are in
`batches-lru-bench.log`. The plain Node script uses built-in type stripping and
a local `.js` → `.ts` resolution hook; an initial unavailable `esbuild` import
was removed before measurement. No package was installed and no build ran.
